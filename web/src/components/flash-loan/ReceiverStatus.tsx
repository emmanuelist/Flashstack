// On-chain status messaging shared by the STX and sBTC flash-loan forms.
// Everything renders nothing while status is unknown (null): the core is the
// real gate, so the UI only speaks up once chain state is known.

export function CoreStatusBadge({ corePaused, unavailable }: { corePaused: boolean | null; unavailable: boolean }) {
  if (corePaused === true) {
    return <span className="text-xs bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-1 rounded-full">Paused</span>;
  }
  if (unavailable) {
    return <span className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-1 rounded-full">No approved receivers</span>;
  }
  if (corePaused === false) {
    return <span className="text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-1 rounded-full">Active</span>;
  }
  return null;
}

export function ReceiverNotApproved({ corePaused }: { corePaused: boolean | null }) {
  return (
    <p role="status" className="text-xs text-amber-300 mt-2 leading-relaxed">
      {corePaused
        ? "The core is paused, so flash loans can't be submitted right now."
        : "This receiver isn't approved on the core right now, so a loan through it would be rejected. Submitting is turned off."}
    </p>
  );
}

export function NoApprovedReceivers({ corePaused }: { corePaused: boolean | null }) {
  return (
    <p role="status" className="text-sm text-amber-300 mb-4 max-w-md mx-auto leading-relaxed">
      {corePaused
        ? "The core is paused right now, so flash loans can't go through."
        : "None of the listed receivers are approved on the core right now, so flash loans can't go through."}
    </p>
  );
}
