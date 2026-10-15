"use client";

import { useState } from "react";
import { usePool } from "@/lib/hooks/usePool";
import { useStacks } from "@/lib/hooks/useStacks";
import { LP_POOLS, PoolAsset } from "@/lib/stacks/config";
import { StateMark } from "@/components/ui/StateMark";

function fmt(base: bigint, decimals: number) {
  return (Number(base) / 10 ** decimals).toLocaleString(undefined, {
    maximumFractionDigits: decimals === 8 ? 8 : 3,
  });
}

function fmtShares(shares: bigint, precision: bigint) {
  return (Number(shares) / Number(precision)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function computeShareValue(poolBalance: bigint, totalShares: bigint, precision: bigint, decimals: number): string {
  if (totalShares === 0n) return (1).toFixed(6);
  const perShare = (poolBalance * precision) / totalShares;
  return (Number(perShare) / 10 ** decimals).toFixed(6);
}

const ASSETS = Object.keys(LP_POOLS) as PoolAsset[];

export default function PoolPage() {
  const { isWalletConnected } = useStacks();
  const [asset, setAsset] = useState<PoolAsset>("stx");
  const meta = LP_POOLS[asset];

  const {
    stats, position, loadingStats,
    deposit, withdraw,
    executeDeposit, executeWithdraw,
    resetDeposit, resetWithdraw,
  } = usePool(asset);

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawPct, setWithdrawPct] = useState(100);

  const shareValue = stats ? computeShareValue(stats.poolBalance, stats.totalShares, meta.sharePrecision, meta.decimals) : "1.000000";
  const shareValueNum = parseFloat(shareValue);

  const fee = depositAmount
    ? ((parseFloat(depositAmount) * (stats?.feeBasisPoints ?? 5)) / 10000).toFixed(meta.decimals === 8 ? 8 : 6)
    : "0";

  const sharesToWithdraw = position
    ? ((position.shares * BigInt(withdrawPct)) / BigInt(100)).toString()
    : "0";
  const toReceive = position && stats && stats.totalShares > 0n
    ? (Number(position.stxValue) * withdrawPct / 100 / 10 ** meta.decimals).toFixed(meta.decimals === 8 ? 8 : 3)
    : "0";

  const handleDeposit = () => {
    if (!depositAmount) return;
    const base = Math.floor(parseFloat(depositAmount) * 10 ** meta.decimals).toString();
    executeDeposit(base);
  };

  const handleWithdraw = () => {
    if (!position || position.shares === 0n) return;
    // Minimum to receive = expected value for this % minus a 1% tolerance (share
    // value only rises with fees, so this bound is conservative), in base units.
    const expectedBase = (position.stxValue * BigInt(withdrawPct)) / 100n;
    const minReceive = ((expectedBase * 99n) / 100n).toString();
    executeWithdraw(sharesToWithdraw, minReceive);
  };

  const switchAsset = (a: PoolAsset) => {
    setAsset(a); setDepositAmount(""); resetDeposit(); resetWithdraw();
  };

  return (
    <div className="max-w-3xl space-y-6 pb-20 md:pb-0">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white">Earn — LP Pools</h2>
        <p className="text-sm text-slate-400 mt-1">
          Deposit {meta.symbol} and earn yield from every flash loan. Fees accumulate automatically — your share grows over time.
        </p>
      </div>

      {/* Asset switcher */}
      <div className="flex gap-1 p-1 bg-surface-card border border-surface-border rounded-xl w-fit">
        {ASSETS.map((a) => (
          <button
            key={a}
            onClick={() => switchAsset(a)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-colors ${
              asset === a ? "bg-brand-600 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            {LP_POOLS[a].symbol}
          </button>
        ))}
      </div>

      {/* Pool Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Pool Balance" value={loadingStats ? "..." : `${fmt(stats?.poolBalance ?? 0n, meta.decimals)} ${meta.symbol}`} />
        <StatCard label="Total Loans" value={loadingStats ? "..." : (stats?.totalLoans ?? 0).toString()} />
        <StatCard label="Fees Earned" value={loadingStats ? "..." : `${fmt(stats?.totalFees ?? 0n, meta.decimals)} ${meta.symbol}`} />
        <StatCard
          label="Share Value"
          value={loadingStats ? "..." : shareValue}
          highlight={!loadingStats && shareValueNum > 1}
          sublabel={!loadingStats && shareValueNum > 1 ? "appreciating" : "at launch value"}
        />
      </div>

      {/* Paused notice. The contract only gates flash-loan on `paused`, so
          deposits and withdrawals still work; warn rather than block. */}
      {stats?.paused && (
        <div role="status" className="rounded-xl border border-circuit-tripped/30 bg-circuit-tripped/[0.06] p-4">
          <StateMark state="tripped">This pool is paused</StateMark>
          <p className="text-sm text-slate-300 mt-1 leading-relaxed">
            No flash loans can be taken from it right now, so deposits earn no new yield until it resumes.
            Withdrawals are unaffected.
          </p>
        </div>
      )}

      {/* Your Position */}
      {isWalletConnected && position && position.shares > 0n && (
        <div className="bg-surface-card border border-surface-border rounded-xl p-4">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-3">Your Position</p>
          <div className="flex gap-6">
            <div>
              <p className="text-2xl font-bold text-white">{fmt(position.stxValue, meta.decimals)} {meta.symbol}</p>
              <p className="text-xs text-slate-400 mt-0.5">Current value</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-brand-400">{fmtShares(position.shares, meta.sharePrecision)}</p>
              <p className="text-xs text-slate-400 mt-0.5">Pool shares</p>
            </div>
          </div>
        </div>
      )}

      {/* Deposit / Withdraw Panel */}
      <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden">
        <div className="flex border-b border-surface-border">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); resetDeposit(); resetWithdraw(); }}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors ${
                tab === t ? "text-white border-b-2 border-brand-500" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4">
          {!isWalletConnected && (
            <p className="text-sm text-slate-400 text-center py-4">Connect your wallet to deposit or withdraw.</p>
          )}

          {isWalletConnected && tab === "deposit" && (
            <>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Amount ({meta.symbol})</label>
                <input
                  type="number" min="0" step="any" placeholder="0.00"
                  value={depositAmount}
                  onChange={(e) => { setDepositAmount(e.target.value); resetDeposit(); }}
                  className="w-full bg-surface border border-surface-border rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 text-sm"
                />
              </div>

              {depositAmount && parseFloat(depositAmount) > 0 && (
                <div className="bg-surface rounded-lg p-3 space-y-1.5 text-xs">
                  <Row label="Deposit" value={`${depositAmount} ${meta.symbol}`} />
                  {stats?.paused ? (
                    <Row label="Yield while paused" value="none" dim />
                  ) : (
                    <>
                      <Row label="Fee per flash loan you earn" value={`${fee} ${meta.symbol} (0.05%)`} dim />
                      <Row label="Your share grows automatically" value="as fees accumulate" dim />
                    </>
                  )}
                </div>
              )}

              {deposit.status === "success" && <TxSuccess txId={deposit.txId} label="Deposit confirmed" />}
              {deposit.status === "error" && <p className="text-sm text-red-400">{deposit.error}</p>}

              <button
                onClick={handleDeposit}
                disabled={deposit.status === "pending" || !depositAmount || parseFloat(depositAmount) <= 0}
                className="w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
              >
                {deposit.status === "pending" ? "Confirm in wallet..." : `Deposit ${meta.symbol}`}
              </button>
            </>
          )}

          {isWalletConnected && tab === "withdraw" && (
            <>
              {(!position || position.shares === 0n) ? (
                <p className="text-sm text-slate-400 text-center py-4">You have no shares in this pool yet. Deposit first.</p>
              ) : (
                <>
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-2">
                      <span>Withdraw percentage</span><span>{withdrawPct}%</span>
                    </div>
                    <input
                      type="range" min={1} max={100} value={withdrawPct}
                      onChange={(e) => { setWithdrawPct(parseInt(e.target.value)); resetWithdraw(); }}
                      className="w-full accent-brand-500"
                    />
                    <div className="flex justify-between text-xs text-slate-500 mt-1">
                      {[25, 50, 75, 100].map(p => (
                        <button key={p} onClick={() => setWithdrawPct(p)} className="hover:text-brand-400 transition-colors">{p}%</button>
                      ))}
                    </div>
                  </div>

                  <div className="bg-surface rounded-lg p-3 space-y-1.5 text-xs">
                    <Row label="You receive" value={`${toReceive} ${meta.symbol}`} />
                    <Row label="Shares burned" value={fmtShares(BigInt(sharesToWithdraw), meta.sharePrecision)} dim />
                  </div>

                  {withdraw.status === "success" && <TxSuccess txId={withdraw.txId} label="Withdrawal confirmed" />}
                  {withdraw.status === "error" && <p className="text-sm text-red-400">{withdraw.error}</p>}

                  <button
                    onClick={handleWithdraw}
                    disabled={withdraw.status === "pending"}
                    className="w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
                  >
                    {withdraw.status === "pending" ? "Confirm in wallet..." : `Withdraw ${withdrawPct}%`}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-5">
        <p className="text-sm font-medium text-white mb-3">How it works</p>
        <ol className="space-y-2 text-sm text-slate-400">
          <li><span className="text-brand-400 font-medium">1.</span> Deposit {meta.symbol} — you receive pool shares proportional to your deposit.</li>
          <li><span className="text-brand-400 font-medium">2.</span> Every flash loan pays a 0.05% fee into the pool.</li>
          <li><span className="text-brand-400 font-medium">3.</span> Fees grow the pool — your share becomes worth more {meta.symbol} over time.</li>
          <li><span className="text-brand-400 font-medium">4.</span> Withdraw anytime — you get principal + all accrued yield.</li>
        </ol>
        <div className="mt-4 pt-4 border-t border-surface-border text-xs text-slate-500">
          <p>Pool contract: <a
            href={`https://explorer.hiro.so/address/${meta.address}.${meta.name}?chain=mainnet`}
            target="_blank" rel="noopener noreferrer"
            className="text-brand-400 hover:underline break-all"
          >{meta.address}.{meta.name}</a></p>
          <p className="mt-1">Hardened v2 pool — virtual-shares inflation protection.</p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, highlight, sublabel }: {
  label: string; value: string; highlight?: boolean; sublabel?: string;
}) {
  return (
    <div className={`border rounded-xl p-4 ${highlight ? "bg-brand-900/10 border-brand-800/30" : "bg-surface-card border-surface-border"}`}>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-lg font-bold mt-1 ${highlight ? "text-brand-400" : "text-white"}`}>{value}</p>
      {sublabel && <p className={`text-xs mt-0.5 ${highlight ? "text-brand-500" : "text-slate-500"}`}>{sublabel}</p>}
    </div>
  );
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={dim ? "text-slate-500" : "text-slate-400"}>{label}</span>
      <span className={dim ? "text-slate-500" : "text-white font-medium"}>{value}</span>
    </div>
  );
}

function TxSuccess({ txId, label }: { txId: string | null; label: string }) {
  return (
    <div className="rounded-lg bg-green-900/20 border border-green-800/40 p-3 text-xs">
      <p className="text-green-400 font-medium">{label}</p>
      {txId && (
        <a
          href={`https://explorer.hiro.so/txid/0x${txId}?chain=mainnet`}
          target="_blank" rel="noopener noreferrer"
          className="text-brand-400 hover:underline break-all mt-1 block"
        >
          View on Explorer →
        </a>
      )}
    </div>
  );
}
