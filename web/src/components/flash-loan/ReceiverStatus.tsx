import { StateMark } from "@/components/ui/StateMark";

// On-chain status messaging shared by the STX and sBTC flash-loan forms.
// Everything renders nothing while status is unknown (null): the core is the
// real gate, so the UI only speaks up once chain state is known.

export function CoreStatusBadge({ corePaused, unavailable, failed = false }: {
  corePaused: boolean | null;
  unavailable: boolean;
  failed?: boolean;
}) {
  if (corePaused === true) return <StateMark state="tripped">Paused</StateMark>;
  if (unavailable) return <StateMark state="open">No approved receivers</StateMark>;
  if (corePaused === false) return <StateMark state="closed">Active</StateMark>;
  if (failed) return <StateMark state="unreachable">Couldn&apos;t reach mainnet</StateMark>;
  return null;
}

export function ReceiverNotApproved({ corePaused }: { corePaused: boolean | null }) {
  return (
    <p role="status" className="text-xs text-circuit-open mt-2 leading-relaxed">
      {corePaused
        ? "The core is paused, so flash loans can't be submitted right now."
        : "This receiver isn't approved on the core right now, so a loan through it would be rejected. Submitting is turned off."}
    </p>
  );
}

export function NoApprovedReceivers({ corePaused }: { corePaused: boolean | null }) {
  return (
    <p role="status" className="text-sm text-circuit-open mb-4 max-w-md mx-auto leading-relaxed">
      {corePaused
        ? "The core is paused right now, so flash loans can't go through."
        : "None of the listed receivers are approved on the core right now, so flash loans can't go through."}
    </p>
  );
}
