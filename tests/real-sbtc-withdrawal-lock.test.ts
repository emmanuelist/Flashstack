import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Cl, ClarityType, cvToValue, type ClarityValue } from "@stacks/transactions";

/**
 * Canonical sBTC locked-balance invariant (ajv.5.2, docs/security/
 * CANONICAL_SBTC_REVIEW.md), proven against the REAL contracts:
 *
 * - lender: the live flashstack-sbtc-core at its mainnet principal (Clarinet
 *   requirement, same mechanism as hk-sbtc-real-receiver-v2.test.ts)
 * - token: the real SM3VDXK3...sbtc-token (built into simnet with
 *   sbtc-registry and sbtc-deposit)
 * - withdrawal: the real SM3VDXK3...sbtc-withdrawal. Simnet does not ship it,
 *   so the verbatim mainnet source (tests/fixtures/sbtc-withdrawal.clar,
 *   sha256-pinned below) is deployed at runtime AT its canonical principal,
 *   which is the one sbtc-registry authorises for the withdrawal role.
 *
 * Canonical get-balance = available + locked, and initiate-withdrawal-request
 * locks tx-sender's own sBTC. A receiver that requests a withdrawal inside the
 * callback therefore locks the BORROWER's sBTC (tx-sender is the borrower,
 * because sbtc-core calls the receiver outside as-contract), and the core's
 * locked balance stays 0. The control shows the same request with
 * tx-sender = a contract locks that contract's own sBTC while its
 * get-balance does not move, which is why a lender must never call the
 * receiver inside as-contract (tests/sbtc-lender-callback-context.test.ts).
 *
 * The test contracts are deployed at runtime with simnet.deployContract, so
 * they never enter the computed mainnet plan.
 */

const SBTC_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC = `${SBTC_DEPLOYER}.sbtc-token`;
const WITHDRAWAL = `${SBTC_DEPLOYER}.sbtc-withdrawal`;
const CORE_ADDR = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";
const CORE = `${CORE_ADDR}.flashstack-sbtc-core`;

const WITHDRAWAL_FIXTURE = "tests/fixtures/sbtc-withdrawal.clar";
// sha256 of the source returned by Hiro /v2/contracts/source for WITHDRAWAL, 2026-10-16.
const WITHDRAWAL_SHA256 = "104a89bc5b54bb5c8c8c1429e2e10e43e324e00249a096f04084d536055e1e71";

const RESERVE = 5_000_000; // core reserve, sats
const LOAN = 100_000;
const FEE = 50; // 5 bp of LOAN, read live below
const WITHDRAW = 1_000; // above the 546-sat dust limit
const BORROWER_SBTC = 10_000;
const RX_BUFFER = 1_000; // receiver pays the fee from this

const RECIPIENT = "{ version: 0x00, hashbytes: 0x0102030405060708090a0b0c0d0e0f1011121314 }";

const receiverSource = `(impl-trait '${CORE_ADDR}.sbtc-flash-receiver-trait.sbtc-flash-receiver-trait)

(define-constant FLASH-CORE '${CORE})
(define-constant OWNER tx-sender)
(define-data-var armed (optional uint) none)

(define-public (arm (amount uint))
  (begin
    (asserts! (is-eq tx-sender OWNER) (err u600))
    (ok (var-set armed (some amount)))))

(define-public (execute-sbtc-flash (amount uint) (core principal))
  (begin
    (asserts! (is-eq contract-caller FLASH-CORE) (err u601))
    (asserts! (is-eq core FLASH-CORE) (err u601))
    (asserts! (is-eq (var-get armed) (some amount)) (err u602))
    (var-set armed none)
    (let (
      (fee-bp (unwrap! (contract-call? '${CORE} get-fee-basis-points) (err u604)))
      (raw-fee (/ (* amount fee-bp) u10000))
      (owed (+ amount (if (> raw-fee u0) raw-fee u1)))
    )
      ;; tx-sender is the borrower here, so this locks the borrower's sBTC.
      (unwrap! (contract-call? '${WITHDRAWAL} initiate-withdrawal-request u${WITHDRAW} ${RECIPIENT} u0) (err u605))
      (unwrap! (as-contract (contract-call? '${SBTC} transfer owed tx-sender FLASH-CORE none)) (err u606))
      (ok true))))
`;

// Control: the same request with tx-sender = this contract.
const lockProbeSource = `(define-public (lock-own (amount uint))
  (as-contract (contract-call? '${WITHDRAWAL} initiate-withdrawal-request amount ${RECIPIENT} u0)))
`;

let deployer: string;
let borrower: string;
let rx: string;
let txSeq = 0;

const ok = (r: { result: ClarityValue }) => {
  if (r.result.type !== ClarityType.ResponseOk) throw new Error(`expected ok, got ${JSON.stringify(cvToValue(r.result))}`);
  return r;
};

const mintSbtc = (amount: number, recipient: string) => {
  const signer = cvToValue(simnet.callReadOnlyFn(`${SBTC_DEPLOYER}.sbtc-registry`, "get-current-signer-principal", [], deployer).result);
  const h = simnet.burnBlockHeight - 1;
  const hash = Cl.deserialize(simnet.runSnippet(`(unwrap-panic (get-burn-block-info? header-hash u${h}))`) as unknown as string);
  const txid = new Uint8Array(32);
  txid[0] = ++txSeq;
  ok(simnet.callPublicFn(`${SBTC_DEPLOYER}.sbtc-deposit`, "complete-deposit-wrapper",
    [Cl.buffer(txid), Cl.uint(0), Cl.uint(amount), Cl.principal(recipient), hash, Cl.uint(h), Cl.buffer(new Uint8Array(32))], signer));
};

const read = (fn: string, who: string) =>
  Number(cvToValue(simnet.callReadOnlyFn(SBTC, fn, [Cl.principal(who)], deployer).result).value);

const balances = (who: string) => ({
  total: read("get-balance", who),
  available: read("get-balance-available", who),
  locked: read("get-balance-locked", who),
});

describe("canonical sBTC: a withdrawal request inside the callback locks the borrower, not the lender", () => {
  beforeEach(() => {
    const accts = simnet.getAccounts();
    deployer = accts.get("deployer")!;
    borrower = accts.get("wallet_1")!;

    const src = readFileSync(WITHDRAWAL_FIXTURE, "utf8");
    expect(createHash("sha256").update(src).digest("hex")).toBe(WITHDRAWAL_SHA256);
    expect(simnet.deployContract("sbtc-withdrawal", src, { clarityVersion: 3 }, SBTC_DEPLOYER).result).toBeBool(true);

    expect(simnet.deployContract("lock-rx", receiverSource, { clarityVersion: 3 }, deployer).result).toBeBool(true);
    rx = `${deployer}.lock-rx`;

    // The live core's admin is its deployer principal.
    mintSbtc(RESERVE, CORE_ADDR);
    ok(simnet.callPublicFn(CORE, "deposit-reserve", [Cl.uint(RESERVE)], CORE_ADDR));
    ok(simnet.callPublicFn(CORE, "add-approved-receiver", [Cl.principal(rx)], CORE_ADDR));
    mintSbtc(RX_BUFFER, rx);
    mintSbtc(BORROWER_SBTC, borrower);
  });

  it("the deployed withdrawal contract is the one the registry authorises", () => {
    expect(simnet.callReadOnlyFn(`${SBTC_DEPLOYER}.sbtc-registry`, "get-active-protocol", [Cl.buffer(new Uint8Array([2]))], deployer).result)
      .toStrictEqual(Cl.some(Cl.principal(WITHDRAWAL)));
  });

  it("loan repays, the borrower's sBTC is locked, and the core's locked balance stays 0", () => {
    const fee = Number(cvToValue(simnet.callReadOnlyFn(CORE, "get-fee-basis-points", [], deployer).result).value);
    expect(Math.max(1, Math.floor((LOAN * fee) / 10_000))).toBe(FEE);

    const coreBefore = balances(CORE);
    const borrowerBefore = balances(borrower);
    expect(coreBefore).toEqual({ total: RESERVE, available: RESERVE, locked: 0 });
    expect(borrowerBefore.locked).toBe(0);
    expect(borrowerBefore.available).toBe(borrowerBefore.total);
    expect(borrowerBefore.total).toBeGreaterThanOrEqual(BORROWER_SBTC);

    ok(simnet.callPublicFn(rx, "arm", [Cl.uint(LOAN)], deployer));
    expect(simnet.callPublicFn(CORE, "flash-loan", [Cl.uint(LOAN), Cl.principal(rx)], borrower).result).toBeOk(Cl.bool(true));

    // Lender: grew by exactly the fee, nothing locked.
    expect(balances(CORE)).toEqual({ total: RESERVE + FEE, available: RESERVE + FEE, locked: 0 });
    // Borrower: same total, but WITHDRAW of it is now locked in the request.
    expect(balances(borrower)).toEqual({
      total: borrowerBefore.total,
      available: borrowerBefore.total - WITHDRAW,
      locked: WITHDRAW,
    });
    // Receiver paid the fee from its buffer and locked nothing of its own.
    expect(balances(rx)).toEqual({ total: RX_BUFFER - FEE, available: RX_BUFFER - FEE, locked: 0 });
  });

  it("control: with tx-sender = a contract, the request locks that contract's sBTC and its get-balance does not move", () => {
    expect(simnet.deployContract("lock-probe", lockProbeSource, { clarityVersion: 3 }, deployer).result).toBeBool(true);
    const probe = `${deployer}.lock-probe`;
    mintSbtc(BORROWER_SBTC, probe);

    ok(simnet.callPublicFn(probe, "lock-own", [Cl.uint(WITHDRAW)], borrower));

    // A balance-delta check on get-balance would see no change, although
    // WITHDRAW sats can no longer be transferred out.
    expect(balances(probe)).toEqual({ total: BORROWER_SBTC, available: BORROWER_SBTC - WITHDRAW, locked: WITHDRAW });
    expect(balances(borrower).locked).toBe(0);
  });
});
