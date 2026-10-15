"use client";

import { useReceiverStatus } from "@/lib/hooks/useReceiverStatus";
import type { FlashCore } from "@/lib/stacks/receiver-client";

/** Live approval status of one receiver on its core; renders nothing until known. */
export function ReceiverApproval({ core, name }: { core: FlashCore; name: string }) {
  const { approved } = useReceiverStatus(core);
  const ok = approved[name];
  if (ok == null) return null;

  return ok ? (
    <span className="text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full">
      Approved on core
    </span>
  ) : (
    <span className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
      Not currently approved
    </span>
  );
}
