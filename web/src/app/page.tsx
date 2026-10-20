"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { fetchStxProtocolStats } from "@/lib/stacks/stx-client";
import { useReceiverStatus } from "@/lib/hooks/useReceiverStatus";

const DEPLOYER = "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5";

function useLiveStats() {
  const [loans, setLoans] = useState<number | null>(null);
  const [volume, setVolume] = useState<string | null>(null);
  const [reserve, setReserve] = useState<string | null>(null);
  const [maxLoan, setMaxLoan] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        // Read live figures straight from flashstack-stx-core.get-stats
        const stats = await fetchStxProtocolStats("mainnet");
        setLoans(stats.totalFlashMints);
        setVolume((Number(stats.totalVolume) / 1e6).toFixed(0));
        setReserve((Number(stats.reserve) / 1e6).toFixed(0));
        setMaxLoan((Number(stats.maxSingleLoan) / 1e6).toLocaleString());
      } catch {
        // leave nulls; UI shows non-live fallbacks
      }
    }
    load();
  }, []);

  return { loans, volume, reserve, maxLoan };
}

export default function LandingPage() {
  const { loans, volume, reserve, maxLoan } = useLiveStats();
  const stxStatus = useReceiverStatus("stx", "mainnet");
  const sbtcStatus = useReceiverStatus("sbtc", "mainnet");
  const loansAvailable = stxStatus.available || sbtcStatus.available;
  const loansUnavailable = stxStatus.unavailable && sbtcStatus.unavailable;

  return (
    <div className="min-h-screen bg-surface text-slate-100 flex flex-col">
      {/* ── Nav ─────────────────────────────────────────── */}
      <header className="border-b border-surface-border sticky top-0 z-50 bg-surface/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/flashstack-logo.svg" alt="FlashStack" width={32} height={32} />
            <span className="text-lg font-bold text-white tracking-tight">FlashStack</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-slate-400">
            <a href="#how-it-works" className="hover:text-white transition-colors">How it works</a>
            <a href="#products" className="hover:text-white transition-colors">Products</a>
            <a href="https://github.com/mattglory/Flashstack" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
          </nav>
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
          >
            Launch App
          </Link>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-brand-600/10 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-6xl mx-auto px-4 md:px-6 pt-20 pb-24 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-600/10 border border-brand-600/20 text-brand-400 text-xs font-medium mb-6">
            {loansAvailable ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
                Live on Stacks Mainnet
              </>
            ) : loansUnavailable ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                On Stacks Mainnet · Flash loans unavailable right now
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />
                On Stacks Mainnet
              </>
            )}
          </div>

          <h1 className="text-4xl md:text-6xl lg:text-7xl font-black tracking-tight mb-6 leading-none">
            Flash Loans on
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-300 to-brand-500">
              Bitcoin Layer 2
            </span>
          </h1>

          <p className="text-lg md:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Borrow <strong className="text-white">STX or canonical sBTC</strong> with zero collateral in a single atomic transaction.
            Repay in the same block or the whole thing reverts — trustless by design.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/flash-loan"
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-base transition-colors shadow-lg shadow-brand-600/20"
            >
              Try a Flash Loan
            </Link>
            <Link
              href="/pool"
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-surface-card hover:bg-surface-hover border border-surface-border text-white font-semibold text-base transition-colors"
            >
              Earn Yield as LP
            </Link>
          </div>
        </div>
      </section>

      {/* ── Live Stats ──────────────────────────────────── */}
      <section className="border-y border-surface-border bg-surface-card">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            <LiveStat label="Flash Loans" value={loans !== null ? loans.toLocaleString() : "—"} live={loans !== null} />
            <LiveStat label="STX Reserve" value={reserve !== null ? `${reserve} STX` : "—"} live={reserve !== null} />
            <LiveStat label="Assets" value="STX + sBTC" />
            <LiveStat label="Fee Rate" value="0.05%" />
          </div>
        </div>
      </section>

      {/* ── Products ────────────────────────────────────── */}
      <section id="products" className="max-w-6xl mx-auto px-4 md:px-6 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">Two ways to use FlashStack</h2>
          <p className="text-slate-400">Whether you're building strategies or providing liquidity.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Flash Loans */}
          <div className="bg-surface-card border border-surface-border rounded-2xl p-7 flex flex-col gap-5 hover:border-brand-600/40 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-brand-600/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-white mb-2">Flash Loans</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Borrow STX or canonical sBTC instantly with no collateral. Execute arbitrage, liquidations, or any on-chain strategy — the loan is atomic. No repayment = full revert. Zero risk to the protocol.
              </p>
            </div>
            <div className="space-y-2 text-sm">
              <Feature text="Zero collateral required" />
              <Feature text="0.05% flat fee per loan" />
              <Feature text={`STX loans up to ${maxLoan ?? "500,000"} STX`} />
              <Feature text="sBTC loans up to 0.1 BTC (canonical)" />
              <Feature text="Build any strategy with receiver contracts" />
            </div>
            <Link
              href="/flash-loan"
              className="mt-auto w-full text-center py-3 rounded-xl bg-brand-600/10 hover:bg-brand-600/20 border border-brand-600/20 text-brand-400 font-medium text-sm transition-colors"
            >
              Borrow STX or sBTC →
            </Link>
          </div>

          {/* LP Pool */}
          <div className="bg-surface-card border border-surface-border rounded-2xl p-7 flex flex-col gap-5 hover:border-brand-600/40 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-green-600/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-white mb-2">LP Pool</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Deposit STX into the liquidity pool and earn a share of every flash loan fee. Like Aave but for flash loans — your share value grows automatically as fees accumulate. Withdraw anytime.
              </p>
            </div>
            <div className="space-y-2 text-sm">
              <Feature text="Earn 0.05% on every flash loan" green />
              <Feature text="No lockup — withdraw anytime" green />
              <Feature text="Share value grows automatically" green />
              <Feature text="Fully non-custodial, on-chain" green />
            </div>
            <Link
              href="/pool"
              className="mt-auto w-full text-center py-3 rounded-xl bg-green-600/10 hover:bg-green-600/20 border border-green-600/20 text-green-400 font-medium text-sm transition-colors"
            >
              Earn Yield →
            </Link>
          </div>
        </div>
      </section>

      {/* ── How It Works ────────────────────────────────── */}
      <section id="how-it-works" className="bg-surface-card border-y border-surface-border">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">How flash loans work</h2>
            <p className="text-slate-400">Everything happens in a single Stacks transaction block.</p>
          </div>

          <div className="grid md:grid-cols-4 gap-4">
            {[
              { n: "01", title: "Request Loan", desc: "Call flash-loan with the amount and your receiver contract address." },
              { n: "02", title: "Receive STX", desc: "FlashStack sends you the full loan amount instantly, no questions asked." },
              { n: "03", title: "Execute Strategy", desc: "Your receiver contract runs — arbitrage, liquidate, swap, anything on-chain." },
              { n: "04", title: "Repay + Fee", desc: "Return principal + 0.05% fee. If you don't, the whole transaction reverts." },
            ].map((step) => (
              <div key={step.n} className="relative p-5 rounded-xl bg-surface border border-surface-border">
                <span className="text-4xl font-black text-brand-600/20">{step.n}</span>
                <h4 className="text-white font-semibold mt-2 mb-1">{step.title}</h4>
                <p className="text-slate-400 text-sm leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Build Section ───────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-4 md:px-6 py-20">
        <div className="grid md:grid-cols-2 gap-10 items-center">
          <div>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Build your strategy</h2>
            <p className="text-slate-400 leading-relaxed mb-6">
              Any Clarity contract can be a FlashStack receiver. Implement the callback, lock it to the core, arm each loan from your owner wallet, deploy, get whitelisted, and access the full STX reserve or up to 0.1 BTC per transaction.
            </p>
            <div className="space-y-3 mb-8">
              <Feature text="STX or sBTC arbitrage between DEXes" />
              <Feature text="Atomic collateral swaps" />
              <Feature text="Leveraged yield positions" />
              <Feature text="Self-liquidation to avoid penalties" />
            </div>
            <Link
              href="/receivers"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-surface-card hover:bg-surface-hover border border-surface-border text-white text-sm font-medium transition-colors"
            >
              View receiver templates →
            </Link>
          </div>
          <div className="bg-surface-card border border-surface-border rounded-xl overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-surface-border">
              <div className="w-3 h-3 rounded-full bg-red-500/50" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
              <div className="w-3 h-3 rounded-full bg-green-500/50" />
              <span className="ml-2 text-xs text-slate-500">my-receiver.clar</span>
            </div>
            <pre className="p-5 text-xs leading-relaxed overflow-x-auto text-slate-300"><code>{`;; Hardened receiver, per docs/security/RECEIVER_VETTING.md:
;; only the core may call it and it repays a hardcoded core (F-10),
;; and only a loan the owner armed can run (C7). Anyone can call
;; flash-loan naming this receiver; without the arm, they could make
;; it run your strategy and spend its fee buffer.
;; Clarity 3: Clarity 4 replaces as-contract with as-contract?.
(impl-trait
  'SP3TGRVG7DKGFVRTTVGGS60S59R916FWB4DAB9STZ.stx-flash-receiver-trait.stx-flash-receiver-trait)

(define-constant FLASH-CORE
  'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core)

(define-data-var owner principal tx-sender)
(define-data-var armed (optional uint) none)

;; Owner arms exactly one loan amount, then calls flash-loan
(define-public (arm-loan (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) (err u403))
    (asserts! (> amount u0) (err u400))
    (ok (var-set armed (some amount)))))

(define-public (disarm)
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) (err u403))
    (ok (var-set armed none))))

(define-public (execute-stx-flash (amount uint) (core principal))
  (begin
    (asserts! (is-eq contract-caller FLASH-CORE) (err u401))
    (asserts! (is-eq core FLASH-CORE) (err u401))
    ;; a loan the owner didn't arm stops here; the arm is single-use
    (asserts! (is-eq (var-get armed) (some amount)) (err u402))
    (var-set armed none)
    (let ((fee-bp (unwrap! (contract-call?
                    'SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core
                    get-fee-basis-points) (err u404)))
          (raw-fee (/ (* amount fee-bp) u10000))
          (owed (+ amount (if (> raw-fee u0) raw-fee u1))))

      ;; --- YOUR STRATEGY HERE ---
      ;; arbitrage, liquidate, swap...
      ;; check profit against the balance read at the start (C9)

      (as-contract (stx-transfer? owed tx-sender FLASH-CORE)))))

;; Before mainnet, also add owner-only rescue (E17) and a
;; two-step ownership transfer (E18).`}</code></pre>
          </div>
        </div>
      </section>

      {/* ── CTA Banner ──────────────────────────────────── */}
      <section className="bg-brand-600/5 border-y border-brand-600/10">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-16 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Ready to try it?
          </h2>
          <p className="text-slate-400 mb-3 max-w-lg mx-auto">
            Connect your Leather wallet on Stacks mainnet. No registration, no KYC, no custodians — just code.
          </p>
          <p className="text-sm text-slate-500 mb-8 max-w-lg mx-auto">
            LP deposits are open to anyone. During the unaudited beta, custom borrowing receivers are allowlisted for safety.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/flash-loan"
              className="px-7 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold transition-colors shadow-lg shadow-brand-600/20"
            >
              Launch App
            </Link>
            <a
              href="https://github.com/mattglory/Flashstack"
              target="_blank"
              rel="noopener noreferrer"
              className="px-7 py-3.5 rounded-xl bg-surface-card hover:bg-surface-hover border border-surface-border text-white font-semibold transition-colors"
            >
              Read the code
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="border-t border-surface-border">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Image src="/flashstack-logo.svg" alt="FlashStack" width={24} height={24} />
            <span className="text-sm font-semibold text-white">FlashStack</span>
            <span className="text-slate-500 text-sm">— Flash Loans on Bitcoin L2</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-slate-500">
            <a
              href={`https://explorer.hiro.so/address/${DEPLOYER}.flashstack-stx-core?chain=mainnet`}
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              Contract
            </a>
            <a
              href="https://github.com/mattglory/Flashstack"
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://x.com/flashstackbtc"
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              X / Twitter
            </a>
            <a
              href="https://skool.com/stackers"
              target="_blank" rel="noopener noreferrer"
              className="hover:text-slate-300 transition-colors"
            >
              Community
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LiveStat({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1.5 mb-1">
        {live && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        <span className="text-xs text-slate-400 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl md:text-3xl font-black text-white">{value}</p>
    </div>
  );
}

function Feature({ text, green }: { text: string; green?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-300">
      <svg className={`w-4 h-4 flex-shrink-0 ${green ? "text-green-400" : "text-brand-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
      {text}
    </div>
  );
}
