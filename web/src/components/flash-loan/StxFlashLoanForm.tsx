"use client";

import { useState } from "react";
import { useStacks } from "@/lib/hooks/useStacks";
import { useStxFlashLoan } from "@/lib/hooks/useStxFlashLoan";
import { useProtocolStats } from "@/lib/hooks/useProtocolStats";
import { useReceiverStatus } from "@/lib/hooks/useReceiverStatus";
import { STX_CONTRACT_ADDRESS, STX_CONTRACT_NAME, STX_RECEIVER_CONTRACTS } from "@/lib/stacks/config";
import { StatCard } from "@/components/dashboard/StatCard";
import { CoreStatusBadge, ReceiverNotApproved, NoApprovedReceivers } from "./ReceiverStatus";

const FEE_BP = 5; // 0.05%

function formatStx(micro: bigint): string {
  return (Number(micro) / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

export function StxFlashLoanForm() {
  const { isWalletConnected, connectWallet } = useStacks();
  const { status, txId, error, executeStxFlashLoan, reset } = useStxFlashLoan();
  const { stats } = useProtocolStats();
  const { corePaused, approved, unavailable, failed } = useReceiverStatus("stx");

  const [amount, setAmount] = useState("");
  const [receiver, setReceiver] = useState(STX_RECEIVER_CONTRACTS[0].name);

  const amountMicro = amount ? Math.floor(parseFloat(amount) * 1_000_000) : 0;
  const rawFee = Math.floor((amountMicro * FEE_BP) / 10000);
  const fee = rawFee > 0 ? rawFee : amountMicro > 0 ? 1 : 0;
  const totalOwed = amountMicro + fee;

  // 5000 STX max single loan (500_000_000_000 microstacks / 1e6 = 500000 STX)
  // actual max is 5000 STX = 5_000_000_000 microstacks
  const MAX_LOAN_STX = 5000;
  const exceedsMax = amountMicro > 0 && amountMicro > MAX_LOAN_STX * 1_000_000;

  if (!isWalletConnected) {
    return (
      <div className="bg-surface-card border border-surface-border rounded-xl p-8 text-center">
        <p className="text-slate-400 mb-4">Connect your wallet to execute STX flash loans</p>
        {unavailable && <NoApprovedReceivers corePaused={corePaused} />}
        <button
          onClick={connectWallet}
          className="px-6 py-2.5 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  const receiverRejected = corePaused === true || approved[receiver] === false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amountMicro || exceedsMax || receiverRejected) return;
    await executeStxFlashLoan(String(amountMicro), receiver);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Execute STX Flash Loan</h2>
        <CoreStatusBadge corePaused={corePaused} unavailable={unavailable} failed={failed} />
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Fee Rate" value="0.05%" subtext="5 basis points" />
        <StatCard label="Max Single Loan" value="5,000 STX" subtext="Reserve-based, no collateral" />
        <StatCard label="Reserve" value={stats ? `${(Number(stats.reserve) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} STX` : "..."} subtext="Protocol liquidity pool" />
      </div>

      <div className="bg-brand-500/5 border border-brand-500/20 rounded-xl p-4">
        <p className="text-slate-300 text-sm">
          <span className="text-brand-400 font-medium">Zero collateral required.</span>{" "}
          Borrow STX, execute your strategy, repay in one atomic transaction.
          If repayment fails, everything reverts — you only lose the Stacks tx fee (~$0.002).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-surface-card border border-surface-border rounded-xl p-6 space-y-5">
        {/* Amount */}
        <div>
          <label className="block text-sm text-slate-400 mb-2">Loan Amount (STX)</label>
          <input
            type="number"
            step="0.000001"
            min="0"
            max={MAX_LOAN_STX}
            value={amount}
            onChange={(e) => { setAmount(e.target.value); reset(); }}
            placeholder="0.00"
            className="w-full px-4 py-3 rounded-lg bg-surface border border-surface-border text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500 text-lg"
          />
          {exceedsMax && (
            <p className="text-red-400 text-xs mt-1">Exceeds max single loan of {MAX_LOAN_STX} STX</p>
          )}
        </div>

        {/* Receiver */}
        <div>
          <label className="block text-sm text-slate-400 mb-2">Receiver Contract</label>
          <select
            value={receiver}
            onChange={(e) => setReceiver(e.target.value)}
            className="w-full px-4 py-3 rounded-lg bg-surface border border-surface-border text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {STX_RECEIVER_CONTRACTS.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}: {r.description}{approved[r.name] === false ? " (not approved)" : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1 break-all">{STX_CONTRACT_ADDRESS}.{receiver}</p>
          {receiverRejected && <ReceiverNotApproved corePaused={corePaused} />}
        </div>

        {/* Preview */}
        {amountMicro > 0 && (
          <div className="bg-surface rounded-lg border border-surface-border p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Loan Amount</span>
              <span className="text-white">{formatStx(BigInt(amountMicro))} STX</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Fee (0.05%)</span>
              <span className="text-white">{formatStx(BigInt(fee))} STX</span>
            </div>
            <div className="border-t border-surface-border pt-2 flex justify-between text-sm font-medium">
              <span className="text-slate-300">Total Repayment</span>
              <span className="text-white">{formatStx(BigInt(totalOwed))} STX</span>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={!amountMicro || status === "pending" || exceedsMax || receiverRejected}
          className="w-full px-6 py-3 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors"
        >
          {status === "pending" ? "Submitting..." : "Execute STX Flash Loan"}
        </button>

        {status === "success" && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
            <p className="text-green-400 text-sm font-medium">Transaction submitted</p>
            {txId && (
              <a
                href={`https://explorer.hiro.so/txid/${txId}?chain=mainnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-400/80 text-xs underline mt-1 block"
              >
                View on Explorer
              </a>
            )}
          </div>
        )}

        {status === "error" && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}
      </form>

      <div className="text-xs text-slate-500 space-y-1 break-all">
        <p>Core contract: <span className="font-mono">{STX_CONTRACT_ADDRESS}.{STX_CONTRACT_NAME}</span></p>
        <p>Receiver must be whitelisted by admin.</p>
      </div>
    </div>
  );
}
