/**
 * On-chain state, named after the mechanic: a flash loan is a circuit that
 * has to close inside one transaction.
 * closed = live, open = no usable path, tripped = paused,
 * unreachable = couldn't read mainnet, null = not yet known
 */
export type CircuitState = "closed" | "open" | "tripped" | "unreachable" | null;

// One mark per circuit state, so state never relies on colour alone:
// closed loop ●, open loop ○, tripped breaker ◆, unreachable ×, unknown ·
const MARK: Record<Exclude<CircuitState, null> | "unknown", { glyph: string; color: string }> = {
  closed: { glyph: "●", color: "text-circuit-closed" },
  open: { glyph: "○", color: "text-circuit-open" },
  tripped: { glyph: "◆", color: "text-circuit-tripped" },
  unreachable: { glyph: "×", color: "text-slate-400" },
  unknown: { glyph: "·", color: "text-slate-500" },
};

export function StateMark({ state, children, className = "" }: {
  state: CircuitState;
  children: React.ReactNode;
  className?: string;
}) {
  const m = MARK[state ?? "unknown"];
  return (
    <span className={`inline-flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.14em] ${m.color} ${className}`}>
      <span aria-hidden>{m.glyph}</span>
      {children}
    </span>
  );
}
