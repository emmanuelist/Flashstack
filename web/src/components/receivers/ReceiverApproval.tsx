"use client";

import { useReceiverStatus } from "@/lib/hooks/useReceiverStatus";
import type { FlashCore } from "@/lib/stacks/receiver-client";
import { StateMark } from "@/components/ui/StateMark";

/** Live approval status of one receiver on its core; renders nothing until known. */
export function ReceiverApproval({ core, name }: { core: FlashCore; name: string }) {
  const { approved } = useReceiverStatus(core);
  const ok = approved[name];
  if (ok == null) return null;

  return ok
    ? <StateMark state="closed">Approved on core</StateMark>
    : <StateMark state="open">Not currently approved</StateMark>;
}

/** Live state of a core: can a listed receiver borrow from it right now? */
export function CoreState({ core = "stx" }: { core?: FlashCore }) {
  const { corePaused, available, unavailable, failed } = useReceiverStatus(core);
  if (corePaused) return <StateMark state="tripped">Core paused</StateMark>;
  if (available) return <StateMark state="closed">Borrowing live</StateMark>;
  if (unavailable) return <StateMark state="open">No approved receivers</StateMark>;
  if (failed) return <StateMark state="unreachable">Couldn&apos;t reach mainnet</StateMark>;
  return null;
}
