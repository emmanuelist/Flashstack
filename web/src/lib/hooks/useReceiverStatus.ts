"use client";

import { useState, useEffect } from "react";
import { useStacks } from "./useStacks";
import { STX_RECEIVER_CONTRACTS, SBTC_RECEIVER_CONTRACTS, NetworkType } from "@/lib/stacks/config";
import { fetchReceiverApproved, fetchCorePaused, FlashCore } from "@/lib/stacks/receiver-client";

const RECEIVERS: Record<FlashCore, { name: string; address: string }[]> = {
  stx: STX_RECEIVER_CONTRACTS,
  sbtc: SBTC_RECEIVER_CONTRACTS,
};

/**
 * On-chain status of a core and its listed receivers. A value is null while
 * loading or if the read failed: callers should only block on a known `false`,
 * since the core itself is the real gate. Pass `fixedNetwork` to ignore the
 * app's network selector (the landing page always describes mainnet).
 */
export function useReceiverStatus(core: FlashCore, fixedNetwork?: NetworkType) {
  const { network: selected } = useStacks();
  const network = fixedNetwork ?? selected;
  const key = `${core}:${network}`;

  // Results are tagged with the core/network they were read for, so switching
  // network shows "unknown" until fresh reads land instead of stale values.
  const [result, setResult] = useState<{
    key: string;
    corePaused: boolean | null;
    approved: Record<string, boolean | null>;
    failed: boolean;
  }>({ key, corePaused: null, approved: {}, failed: false });

  useEffect(() => {
    let cancelled = false;
    const merge = (patch: { corePaused?: boolean; approved?: Record<string, boolean>; failed?: true }) => {
      if (cancelled) return;
      setResult((prev) => {
        const base = prev.key === key ? prev : { key, corePaused: null, approved: {}, failed: false };
        return {
          key,
          corePaused: patch.corePaused ?? base.corePaused,
          approved: { ...base.approved, ...patch.approved },
          failed: patch.failed ?? base.failed,
        };
      });
    };

    fetchCorePaused(core, network)
      .then((p) => merge({ corePaused: p }))
      .catch(() => merge({ failed: true }));

    for (const r of RECEIVERS[core]) {
      fetchReceiverApproved(core, r, network)
        .then((ok) => merge({ approved: { [r.name]: ok } }))
        .catch(() => merge({ failed: true }));
    }

    return () => { cancelled = true; };
  }, [core, network, key]);

  const corePaused = result.key === key ? result.corePaused : null;
  const approved = result.key === key ? result.approved : {};
  // A read failed, so some values may stay unknown (e.g. rate limited)
  const failed = result.key === key && result.failed;

  const statuses = RECEIVERS[core].map((r) => approved[r.name] ?? null);
  // true once every listed receiver is known to be unapproved, or the core is paused
  const unavailable = corePaused === true || (statuses.length > 0 && statuses.every((s) => s === false));
  // true once the core is known active and at least one receiver is known approved
  const available = corePaused === false && statuses.some((s) => s === true);

  return { corePaused, approved, available, unavailable, failed };
}
