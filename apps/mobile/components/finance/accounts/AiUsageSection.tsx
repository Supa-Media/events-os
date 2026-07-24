/**
 * "AI usage" — the audit trail the owner made a CONDITION of allowing a PAID
 * OpenRouter model for finance auto-coding (see `apps/convex/aiCoding.ts` +
 * `schema/aiUsage.ts`). Every OpenRouter call the auto-coder makes (success
 * or failure) is logged; this section is where that log gets reviewed —
 * month-to-date totals plus a compact recent-events list. Backed by
 * `api.aiCodingData.getUsageSummary`, which shares the Accounts tab's ED/FM
 * gate (`requireCentralEdOrFm`) — this component only ever mounts inside
 * `AccountsBody`, which is itself gated the same way `accounts.tsx` gates
 * everything else on this screen.
 *
 * Deliberately compact: no new tab, no charts — three stat cells + a short
 * list, matching this screen's existing section/card idiom.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatUsdMicros } from "@events-os/shared";
import { Badge, Card, Icon, SectionHeader, type BadgeTone } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDateTime } from "../../../lib/format";

/** How many recent events to show inline — a glance, not a ledger. The query
 *  itself carries more (`USAGE_RECENT_LIMIT` in `aiCodingData.ts`); this is
 *  just how much of that we render to stay compact. */
const VISIBLE_RECENT = 6;

const OUTCOME: Record<
  "suggested" | "failed" | "no_suggestion",
  { label: string; tone: BadgeTone }
> = {
  suggested: { label: "Suggested", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  no_suggestion: { label: "No match", tone: "neutral" },
};

/** How a call originated (`aiUsageEvents.triggeredBy`) — "ingest" is the
 *  debounced sweep that fires soon after a new transaction lands, distinct
 *  from the hourly cron backstop and a bookkeeper's on-demand "Suggest" tap
 *  in Reconcile. See `aiCodingData.ts`'s `runSuggestionSweep`. */
const TRIGGERED_BY_LABEL: Record<"sweep" | "ingest" | "manual", string> = {
  sweep: "Hourly sweep",
  ingest: "On arrival",
  manual: "Manual",
};

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1">
      <Text className="font-display text-xl text-ink">{value}</Text>
      <Text className="text-xs text-muted">{label}</Text>
    </View>
  );
}

export function AiUsageSection() {
  const usage = useQuery(api.aiCodingData.getUsageSummary, {});

  return (
    <>
      <SectionHeader title="AI usage" titleAccessory={<AiUsageIcon />} />
      <Text className="mb-3 text-sm text-muted">
        New charges get a coding suggestion within seconds of arriving —
        review it in Reconcile, or tap "Suggest" on any charge that doesn't
        have one yet. Every call — who/what it was for, which model, and its
        cost — is logged for review here. This is the audit trail behind
        allowing a paid model.
      </Text>

      {usage === undefined ? (
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      ) : (
        <>
          <Card>
            <View className="flex-row gap-4">
              <StatCell
                label="Calls (MTD)"
                value={String(usage.monthToDate.calls)}
              />
              <StatCell
                label="Est. cost (MTD)"
                value={formatUsdMicros(usage.monthToDate.costUsdMicros)}
              />
              <StatCell
                label="Accept rate (MTD)"
                value={
                  usage.monthToDate.acceptRate === null
                    ? "—"
                    : `${Math.round(usage.monthToDate.acceptRate * 100)}%`
                }
              />
            </View>
          </Card>

          {usage.recentEvents.length === 0 ? (
            <Text className="mt-3 text-sm text-muted">
              No AI coding calls yet.
            </Text>
          ) : (
            <Card className="mt-3">
              <View className="gap-2">
                {usage.recentEvents.slice(0, VISIBLE_RECENT).map((e, i) => {
                  const outcome = OUTCOME[e.outcome];
                  const subject = e.cardholderName ?? e.merchantName;
                  return (
                    <View
                      key={e.id}
                      className={`gap-1 py-2 ${
                        i > 0 ? "border-t border-border-strong" : ""
                      }`}
                    >
                      <View className="flex-row items-center justify-between gap-2">
                        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                          {subject ?? "(no linked transaction)"}
                        </Text>
                        <Badge label={outcome.label} tone={outcome.tone} />
                        {e.suggestionAccepted ? (
                          <Badge label="Accepted" tone="lavender" />
                        ) : null}
                      </View>
                      <Text className="text-xs text-faint">
                        {formatDateTime(e.createdAt)} ·{" "}
                        {TRIGGERED_BY_LABEL[e.triggeredBy]} ·{" "}
                        {e.model} · {formatUsdMicros(e.costUsdMicros)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function AiUsageIcon() {
  return <Icon name="sparkles" size={13} color={colors.muted} />;
}
