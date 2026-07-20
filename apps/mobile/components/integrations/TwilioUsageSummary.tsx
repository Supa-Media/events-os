/**
 * "SMS usage" — the Twilio spend rollup for Profile → Integrations, the SMS
 * analog of `AiUsageSection.tsx` (finance's "AI usage" panel). Backed by
 * `api.smsUsage.getSmsSpendSummary`, which soft-gates (superuser or central
 * ED/FM; anyone else gets null, never a throw) so this panel renders nothing
 * for unauthorized viewers instead of crashing the integrations screen.
 *
 * Mounted in integrations.tsx, right below the Twilio connection card.
 *
 * Deliberately compact: current-month total + blast/verification split, a
 * one-line previous-month comparison, and a short per-chapter list — no new
 * screen, no charts, matching `AiUsageSection`'s idiom.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatUsdMicros } from "@events-os/shared";
import { Card, Icon, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1">
      <Text className="font-display text-xl text-ink">{value}</Text>
      <Text className="text-xs text-muted">{label}</Text>
    </View>
  );
}

function SmsUsageIcon() {
  return <Icon name="message-circle" size={13} color={colors.muted} />;
}

export function TwilioUsageSummary() {
  const usage = useQuery(api.smsUsage.getSmsSpendSummary, {});

  if (usage === undefined) {
    return (
      <>
        <SectionHeader title="SMS usage" titleAccessory={<SmsUsageIcon />} />
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      </>
    );
  }

  if (usage === null) {
    // Caller isn't a superuser or central ED/FM — the query soft-gates with
    // null instead of throwing, and the panel simply doesn't render.
    return null;
  }

  const { currentMonth, previousMonth, byChapter, truncated } = usage;
  // A truncated scan (SPEND_SCAN_LIMIT rows hit) means every total below is a
  // FLOOR, not the real number — flag it visually rather than showing a
  // confidently-wrong figure.
  const atLeast = truncated ? "≥" : "";

  return (
    <>
      <SectionHeader title="SMS usage" titleAccessory={<SmsUsageIcon />} />
      <Text className="mb-3 text-sm text-muted">
        Every text — a blast or a verification code — is logged here. Costs
        are an ESTIMATE (segments × a flat per-segment price), not a live
        Twilio bill; see docs/plans/sms-comms.md for the finance recipe (a
        recurring monthly "SMS / Texting" budget, no per-text transactions).
      </Text>

      <Card>
        <View className="flex-row gap-4">
          <StatCell
            label="Segments (MTD)"
            value={`${atLeast}${currentMonth.segments.toLocaleString()}`}
          />
          <StatCell
            label="Est. cost (MTD)"
            value={`${atLeast}${formatUsdMicros(currentMonth.costUsdMicros)}`}
          />
          <StatCell
            label="Blast vs. verify"
            value={`${currentMonth.byPurpose.blast.segments} / ${currentMonth.byPurpose.verification.segments}`}
          />
        </View>
        <Text className="mt-2 text-xs text-faint">
          Last month: {atLeast}
          {formatUsdMicros(previousMonth.costUsdMicros)} · {atLeast}
          {previousMonth.segments.toLocaleString()} segments
        </Text>
        {truncated ? (
          <Text className="mt-1 text-xs text-muted">
            Amounts may be understated (row cap reached).
          </Text>
        ) : null}
      </Card>

      {byChapter.length === 0 ? (
        <Text className="mt-3 text-sm text-muted">No SMS sends this month.</Text>
      ) : (
        <Card className="mt-3">
          <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-muted">
            This month, by chapter
          </Text>
          <View className="gap-2">
            {byChapter.map((c, i) => (
              <View
                key={c.chapterId}
                className={`flex-row items-center justify-between gap-2 py-1.5 ${
                  i > 0 ? "border-t border-border-strong" : ""
                }`}
              >
                <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                  {c.chapterName}
                </Text>
                <Text className="text-xs text-faint">
                  {c.segments.toLocaleString()} segments ·{" "}
                  {atLeast}
                  {formatUsdMicros(c.costUsdMicros)}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
    </>
  );
}
