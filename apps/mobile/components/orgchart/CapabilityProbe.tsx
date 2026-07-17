import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * Invisible probe: fetches ONE seat's full detail and reports whether it
 * carries `org.editChart` back to the parent via `onResult`.
 *
 * `seats.chart` (what the org-chart screen already holds) does NOT include
 * per-seat capabilities — only `seats.seatDetail` does (see `seats.ts`'s
 * `seatNodeValidator` vs `seatDetail`'s return validator). So the "Edit
 * structure" toggle's gate — "does the caller hold a seat with
 * `org.editChart`" — is resolved by mounting one of these per seat the
 * caller holds (`seats.mySeatAssignments`, almost always 0-2 rows) rather
 * than a single extra query. Renders nothing.
 */
export function EditChartCapabilityProbe({
  defId,
  scope,
  onResult,
}: {
  defId: Id<"seatDefs">;
  scope: "central" | Id<"chapters">;
  onResult: (assignmentKey: string, hasEditChart: boolean) => void;
}) {
  const detail = useQuery(api.seats.seatDetail, { defId, scope });
  useEffect(() => {
    if (detail) {
      onResult(`${scope}:${defId}`, detail.capabilities.includes("org.editChart"));
    }
    // `onResult` is a stable useCallback from the caller — omitted from deps
    // on purpose so a caller re-render doesn't re-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, defId, scope]);
  return null;
}
