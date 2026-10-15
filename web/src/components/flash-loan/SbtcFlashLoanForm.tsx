"use client";

import { useState } from "react";
import { useStacks } from "@/lib/hooks/useStacks";
import { useSbtcFlashLoan } from "@/lib/hooks/useSbtcFlashLoan";
import { useReceiverStatus } from "@/lib/hooks/useReceiverStatus";
import {
  SBTC_CONTRACT_ADDRESS,
  SBTC_CONTRACT_NAME,
  SBTC_RECEIVER_CONTRACTS,
} from "@/lib/stacks/config";
import { StatCard } from "@/components/dashboard/StatCard";
import { CoreStatusBadge, ReceiverNotApproved, NoApprovedReceivers } from "./ReceiverStatus";

const FEE_BP = 5; // 0.05%
const MAX_LOAN_SATS = 10_000_000; // 0.1 BTC (10M sats)

function formatSats(sats: number): string {
  if (sats === 0) return "0";
  if (sats < 1000) return `${sats} sats`;
  return `${(sats / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC`;
}

function formatBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "");
}

export function SbtcFlashLoanForm() {
  const { isWalletConnected, connectWallet } = useStacks();
  const { status, txId, error, executeSbtcFlashLoan, reset } = useSbtcFlashLoan();
  const { corePaused, approved, unavailable, failed } = useReceiverStatus("sbtc");

  const [amount, setAmount] = useState("");
  const [receiver, setReceiver] = useState(SBTC_RECEIVER_CONTRACTS[0].name);

  // amount is in BTC (e.g. "0.0001"), convert to sats
  const amountSats = amount ? Math.floor(parseFloat(amount) * 1e8) : 0;
  const rawFee = Math.floor((amountSats * FEE_BP) / 10000);
  const fee = rawFee > 0 ? rawFee : amountSats > 0 ? 1 : 0;
  const totalOwed = amountSats + fee;
  const exceedsMax = amountSats > 0 && amountSats > MAX_LOAN_SATS;

  if (!isWalletConnected) {
    return (
      <div className="bg-surface-card border border-surface-border rounded-xl p-8 text-center">
        <p className="text-slate-400 mb-4">Connect your wallet to execute sBTC flash loans</p>
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
    if (!amountSats || exceedsMax || receiverRejected) return;
    await executeSbtcFlashLoan(String(amountSats), receiver);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Execute sBTC Flash Loan</h2>
        <div className="flex items-center gap-2">
          <CoreStatusBadge corePaused={corePaused} unavailable={unavailable} failed={failed} />
          <span className="text-xs bg-orange-500/10 text-orange-400 border border-orange-500/20 px-2 py-1 rounded-full">
            Canonical sBTC
          </span>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Fee Rate" value="0.05%" subtext="5 basis points" />
        <StatCard label="Max Single Loan" value="0.1 BTC" subtext="10,000,000 sats" />
        <StatCard label="Token" value="sBTC" subtext="SM3VDX...sbtc-token" />
      </div>

      <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-4">
        <p className="text-slate-300 text-sm">
          <span className="text-orange-400 font-medium">Real Bitcoin, zero collateral.</span>{" "}
          Borrow canonical sBTC (backed 1:1 by BTC), execute your strategy, repay in one atomic
          transaction. If repayment fails, everything reverts.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-surface-card border border-surface-border rounded-xl p-6 space-y-5"
      >
        {/* Amount */}
        <div>
          <label className="block text-sm text-slate-400 mb-2">Loan Amount (BTC)</label>
          <input
            type="number"
            step="0.00000001"
            min="0"
            max="0.1"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              reset();
            }}
            placeholder="0.00000000"
            className="w-full px-4 py-3 rounded-lg bg-surface border border-surface-border text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500 text-lg"
          />
          {exceedsMax && (
            <p className="text-red-400 text-xs mt-1">Exceeds max single loan of 0.1 BTC (10M sats)</p>
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
            {SBTC_RECEIVER_CONTRACTS.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}: {r.description}{approved[r.name] === false ? " (not approved)" : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1 break-all">
            {SBTC_CONTRACT_ADDRESS}.{receiver}
          </p>
          {receiverRejected && <ReceiverNotApproved corePaused={corePaused} />}
        </div>

        {/* Preview */}
        {amountSats > 0 && (
          <div className="bg-surface rounded-lg border border-surface-border p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Loan Amount</span>
              <span className="text-white">{formatBtc(amountSats)} BTC ({amountSats.toLocaleString()} sats)</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Fee (0.05%)</span>
              <span className="text-white">{fee.toLocaleString()} sats</span>
            </div>
            <div className="border-t border-surface-border pt-2 flex justify-between text-sm font-medium">
              <span className="text-slate-300">Total Repayment</span>
              <span className="text-white">{formatSats(totalOwed)}</span>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={!amountSats || status === "pending" || exceedsMax || receiverRejected}
          className="w-full px-6 py-3 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors"
        >
          {status === "pending" ? "Submitting..." : "Execute sBTC Flash Loan"}
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
        <p>
          Core: <span className="font-mono">{SBTC_CONTRACT_ADDRESS}.{SBTC_CONTRACT_NAME}</span>
        </p>
        <p>
          Token: <span className="font-mono">SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token</span>
        </p>
      </div>
    </div>
  );
}
