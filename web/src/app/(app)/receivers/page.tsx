import { STX_CONTRACT_ADDRESS, STX_CONTRACT_NAME } from "@/lib/stacks/config";
import { ReceiverApproval } from "@/components/receivers/ReceiverApproval";

const LIVE_STX_RECEIVERS = [
  {
    name: "stx-test-receiver",
    label: "STX Test Receiver",
    description: "Borrow STX, repay principal + fee. Use this to verify flash loans work from your wallet.",
    address: STX_CONTRACT_ADDRESS,
  },
];

const TEMPLATE_RECEIVERS = [
  { name: "liquidation-receiver", label: "Liquidation Bot", description: "Flash-loan-powered vault liquidator — template for lending protocol liquidations." },
  { name: "leverage-loop-receiver", label: "Leverage Loop", description: "Borrow STX, deposit as collateral, borrow again — builds leveraged yield positions." },
  { name: "collateral-swap-receiver", label: "Collateral Swap", description: "Atomically swap one collateral type for another without closing your position." },
  { name: "yield-optimization-receiver", label: "Yield Optimizer", description: "Auto-compound yield by flash-loaning to claim rewards and redeploy." },
];

export default function ReceiversPage() {
  return (
    <div className="max-w-5xl space-y-10 pb-20 md:pb-0">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Receiver Contracts</h1>
        <p className="text-slate-400 text-sm">
          Receivers deployed on Stacks mainnet, with their live approval status on the core. Templates show what you can build.
        </p>
      </div>

      {/* Live STX Receivers */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-white font-semibold">STX Flash Loans</h2>
          <span className="text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full">
            Live on Mainnet
          </span>
        </div>
        <p className="text-slate-500 text-xs mb-4 font-mono break-all">
          Core: {STX_CONTRACT_ADDRESS}.{STX_CONTRACT_NAME}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {LIVE_STX_RECEIVERS.map((r) => (
            <a
              key={r.name}
              href={`https://explorer.hiro.so/address/${r.address}.${r.name}?chain=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-surface-card border border-surface-border rounded-xl p-5 hover:border-brand-500/50 transition-colors group"
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-white font-medium text-sm group-hover:text-brand-400 transition-colors">
                  {r.label}
                </span>
                <svg className="w-3.5 h-3.5 text-slate-500 group-hover:text-brand-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>
              <p className="text-slate-400 text-xs mb-3 leading-relaxed">{r.description}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs text-slate-600">.{r.name}</p>
                <ReceiverApproval core="stx" name={r.name} />
              </div>
            </a>
          ))}
        </div>
      </div>

      {/* Strategy Templates */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-white font-semibold">Strategy Templates</h2>
          <span className="text-xs bg-slate-500/10 text-slate-400 border border-slate-500/20 px-2 py-0.5 rounded-full">
            Build your own
          </span>
        </div>
        <p className="text-slate-500 text-sm mb-4">
          These are reference implementations showing what you can build with flash loans. Deploy your own version and request whitelisting.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {TEMPLATE_RECEIVERS.map((r) => (
            <div
              key={r.name}
              className="bg-surface-card border border-dashed border-surface-border rounded-xl p-5 opacity-70"
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-slate-300 font-medium text-sm">{r.label}</span>
                <span className="text-xs text-slate-500 bg-surface-hover px-2 py-0.5 rounded-full flex-shrink-0">Template</span>
              </div>
              <p className="text-slate-500 text-xs leading-relaxed">{r.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Build Your Own */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6">
        <h2 className="text-white font-semibold mb-1">Build Your Own Receiver</h2>
        <p className="text-slate-400 text-sm mb-5 leading-relaxed">
          Implement <code className="text-slate-300 bg-surface-hover px-1.5 py-0.5 rounded text-xs">stx-flash-receiver-trait</code>: one function.
          Lock it to the core with a <code className="text-slate-300 bg-surface-hover px-1.5 py-0.5 rounded text-xs">contract-caller</code> check and repay a hardcoded core,
          never the <code className="text-slate-300 bg-surface-hover px-1.5 py-0.5 rounded text-xs">core</code> argument. Receivers without this could be drained and were
          de-approved (finding F-10). Then deploy and DM us to get whitelisted. If your strategy can&apos;t repay, the entire tx reverts.
        </p>
        <pre className="bg-surface rounded-lg border border-surface-border p-4 text-xs text-slate-300 overflow-x-auto leading-relaxed">
{`;; Hardened receiver: only the core may call it, and it
;; repays a hardcoded core, never the core argument (F-10)
(impl-trait
  'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant FLASH-CORE
  'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-public (execute-stx-flash (amount uint) (core principal))
  (let ((raw-fee (/ (* amount u5) u10000))            ;; 0.05%
        (owed (+ amount (if (> raw-fee u0) raw-fee u1))))
    (asserts! (is-eq contract-caller FLASH-CORE) (err u401))
    (asserts! (is-eq core FLASH-CORE) (err u401))

    ;; --- YOUR STRATEGY HERE ---
    ;; arbitrage, liquidate, swap...

    (as-contract (stx-transfer? owed tx-sender FLASH-CORE))))

;; Deploy, then ask to be approved on the core`}
        </pre>

        <div className="mt-4 pt-4 border-t border-surface-border flex flex-col sm:flex-row gap-3">
          <a
            href="https://github.com/mattglory/Flashstack/tree/main/contracts"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-brand-400 hover:text-brand-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            View contract source on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
