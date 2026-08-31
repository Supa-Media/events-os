/**
 * TransactionHistoryCompact — the compact, bounded `financeAuditLog` trail
 * for one transaction (renames, recodes, category changes, exclusions — each
 * with actor + date), for the sheet/panel CONTEXT area.
 *
 * FINDING 4 (UX audit, 2026-08-12): the audit trail existed
 * (`finances.financeAuditTrail`, and `TransactionDetailModal`'s own History
 * section reads it) but was invisible on the two surfaces where a treasurer
 * actually WORKS a charge — the cardholder/workbench sheet
 * (`FinishChargeSheetBody`) and the Reconcile note panel
 * (`TransactionDocumentationModal`). This is that section, built once and
 * mounted on both rather than forked twice.
 *
 * Reads the SAME query and read gate `TransactionDetailModal`'s History
 * section already uses (bookkeeper+, scope-matched to `requireReconcileTxn` —
 * see `financeAuditTrail`'s own doc comment in `finances.ts`). A caller
 * outside that gate just sees an empty section (matches this codebase's
 * "no dead disabled buttons" posture everywhere else finance read-gates).
 *
 * EAGERLY FETCHED, not click-gated — the whole point is that a treasurer sees
 * it's THERE without an extra tap, and it's cheap (bounded to the 10 most
 * recent rows). Small histories (3 or fewer) render inline; longer ones
 * collapse behind "History (N)" so this never competes for space with the
 * form above it.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueries, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { FINANCE_AUDIT_ACTION_LABELS } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

type TrailRow = FunctionReturnType<typeof api.finances.financeAuditTrail>[number];

/** Rows at/below this count render directly — a collapsed toggle for 1-3
 *  lines would just be an extra tap to see almost nothing. */
const INLINE_THRESHOLD = 3;
/** "Most recent ~10" per the finding — `financeAuditTrail` can return up to
 *  its own 200-row scan limit; this is the display cap, not the read cap. */
const DISPLAY_LIMIT = 10;

function when(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export function TransactionHistoryCompact({
  transactionId,
}: {
  transactionId: Id<"transactions">;
}) {
  const [expanded, setExpanded] = useState(false);
  // READ THROUGH `useQueries`, NEVER `useQuery`. This component used to say
  // "the query silently returns `[]` rather than throwing — see its own doc
  // comment", and trusted it. It wasn't true: the gate degraded on scope but
  // THREW on rank, and the handler's empty-log early return hid that from
  // every fixture. On a charge with any history at all — one attached
  // receipt is enough — a cardholder opening the coding sheet had this strip
  // throw during render, unwind to the root `ErrorBoundary`, and take the
  // whole page (2026-08-31).
  //
  // The server now degrades as documented. This reads through `useQueries`
  // anyway, because the claim above is the kind that goes stale silently and
  // a decoration must never be able to cost the page. Same idiom, same
  // reason, as `receiptSuggestions.ts` and `ReceiptViewerModal`.
  const request = useMemo<RequestForQueries>(
    () => ({
      trail: {
        query: api.finances.financeAuditTrail,
        args: { subjectType: "transaction" as const, subjectId: transactionId },
      },
    }),
    [transactionId],
  );
  const results = useQueries(request);
  const raw = results.trail;
  const rows = Array.isArray(raw) ? (raw as TrailRow[]) : undefined;

  // Loading, refused, or genuinely no history yet: render nothing rather than
  // an empty "History" heading with nothing under it.
  if (rows === undefined || rows.length === 0) return null;

  const recent = rows.slice(0, DISPLAY_LIMIT);
  const collapsible = recent.length > INLINE_THRESHOLD;
  const showRows = !collapsible || expanded;

  return (
    <View className="border-t border-border pt-3">
      {collapsible ? (
        <Pressable
          onPress={() => setExpanded((e) => !e)}
          accessibilityRole="button"
          className="flex-row items-center gap-1 self-start active:opacity-70 web:hover:opacity-90"
        >
          <Icon
            name={expanded ? "chevron-up" : "chevron-down"}
            size={14}
            color={colors.muted}
          />
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            History ({recent.length})
          </Text>
        </Pressable>
      ) : (
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          History
        </Text>
      )}
      {showRows ? (
        <View className="mt-2 gap-2.5">
          {recent.map((r) => (
            <View key={r.id} className="border-l-2 border-border pl-2">
              <Text className="text-xs font-medium text-ink">
                {FINANCE_AUDIT_ACTION_LABELS[r.action]}
                {r.field ? ` — ${r.field}` : ""}
              </Text>
              {/* `before`/`after` arrive ALREADY WORDED. `financeAuditTrail`
                  renders every keyed row through the one shared renderer
                  server-side (`financeAuditValueLabel`), so a status renamed
                  tomorrow reads the new word here without this file changing
                  — and the `beforeKey`/`afterKey` it also hands over are for
                  REASONING about state, never for printing. */}
              {r.before != null || r.after != null ? (
                <Text className="text-xs text-muted" numberOfLines={2}>
                  {r.before ?? "—"} → {r.after ?? "—"}
                </Text>
              ) : null}
              {r.reason ? (
                <Text className="text-xs text-muted" numberOfLines={3}>
                  Reason: {r.reason}
                </Text>
              ) : null}
              <Text className="text-2xs text-faint">
                {r.actorName ?? "Unknown"} · {when(r.createdAt)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
