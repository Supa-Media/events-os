/**
 * THE PUBLISHABILITY CARD — "what stands between this period and publication".
 *
 * Public Worship is about to make every transaction public
 * (`docs/plans/transaction-coding.md`, phase 4). A period is publishable only
 * when all THREE axes are green on every row it contains: documentation (a
 * receipt or an approved receipt exception), coding (an approved
 * substantiation record — what/why/who), and review (closed). This card is
 * the close-gate artifact on the dashboard: one headline the ED can read in a
 * meeting, and a tap for the per-axis breakdown behind it.
 *
 * WHY THE HEADLINE IS THE UNION, NOT A SUM. One bare charge is open on all
 * three axes at once. Adding the three axis counts would report it three times
 * and produce a "problems" number that matches no set of rows — the dead
 * number this whole area keeps fighting. So the headline is `blocked` (rows
 * open on AT LEAST one axis) and the expanded view shows the three axes plus
 * the overlap that explains why they add up to more. Server-side those are
 * four independently accumulated populations; see
 * `apps/convex/publishability.ts`.
 *
 * TWO LINES THAT LOOK LIKE FOOTNOTES AND AREN'T:
 *  - "Reconstructed history" — rows rebuilt from spreadsheets rather than
 *    watched as they happened (`isReconstructedHistory`). They can be green on
 *    all three axes and still not be the same claim as a live-captured row, so
 *    they're named here rather than folded silently into the green count.
 *  - "Outside the coding policy" — spend posted before
 *    `codingRequiredSinceMs` (2026-09-01) owes no coding at all. It is NEVER
 *    part of the coding gap; showing how much of the period it covers is what
 *    keeps that exemption a stated fact instead of a silent omission.
 *
 * ACCESS. The query gates on `lib/publishabilityAccess.ts` (finance viewer+
 * for your own book, central reach for central/all-books) and throws a
 * `ConvexError` otherwise — so this card is mounted inside a
 * `FinanceBoundary` with a `null` fallback and simply isn't there for a caller
 * who may not read it. No second, client-side copy of the rule to drift.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money } from "./parts";
import type { DashPeriodMode } from "./parts";

type Gap = { count: number; cents: number };

/** "3 charges · $58.30" — every figure in this report is a count AND a dollar
 *  total, because a close meeting asks both (rows are triage effort, dollars
 *  are exposure) and either one alone invites the wrong conclusion. */
function rowsAnd(gap: Gap): string {
  return `${gap.count} ${gap.count === 1 ? "row" : "rows"} · ${formatCents(gap.cents)}`;
}

export function PublishabilityCard({
  year,
  month,
  period,
  scope,
  chapterId,
}: {
  year: number;
  month: number;
  period: DashPeriodMode;
  /** `"central"` for the central desk; omitted for a chapter book. */
  scope?: "central";
  /** The chapter book to report on (the peeked chapter, or the caller's own).
   *  Ignored when `scope` is `"central"`. */
  chapterId?: Id<"chapters">;
}) {
  const [open, setOpen] = useState(false);
  // The dashboard's YTD mode is "January through the selected month", which
  // isn't a shape this report takes an argument for — so YTD reads the WHOLE
  // year and the card prints the server's own `period.label` ("2026") rather
  // than the stepper's month. Never label a figure with a period it wasn't
  // measured over.
  const data = useQuery(api.publishability.report, {
    year,
    ...(period === "month" ? { month } : {}),
    ...(scope === "central" ? { scope } : chapterId ? { chapterId } : {}),
  });

  if (data === undefined || data === null) return null;
  const { totals, period: p } = data;
  // An empty period has nothing to gate. Rendering "0 rows are publishable"
  // would read as an all-clear on a month nobody has imported yet.
  if (totals.inScope.count === 0) return null;

  const clear = totals.blocked.count === 0;

  return (
    <View className="mb-4 overflow-hidden rounded-lg border border-border bg-raised">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center gap-3 p-3"
      >
        <Icon
          name={clear ? "check-circle" : "alert-triangle"}
          size={16}
          color={clear ? colors.success : colors.warn}
        />
        <View className="flex-1">
          <Text className="text-2xs uppercase tracking-wide text-muted">
            Publishable · {p.label}
          </Text>
          {clear ? (
            <Text className="text-sm font-semibold text-ink">
              All {totals.inScope.count} rows are ready to publish
            </Text>
          ) : (
            <Text className="text-sm font-semibold text-ink">
              {rowsAnd(totals.blocked)} not publishable yet
            </Text>
          )}
          <Text className="text-2xs text-muted">
            {totals.publishable.count} of {totals.inScope.count} rows green on
            documentation, coding and review
          </Text>
        </View>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
      </Pressable>

      {open ? (
        <View className="gap-2 border-t border-border p-3">
          <AxisRow
            icon="paperclip"
            label="Documentation"
            hint="No receipt and no approved exception"
            gap={totals.axes.documentation}
          />
          <AxisRow
            icon="edit-3"
            label="Coding"
            hint="Owes an approved substantiation record"
            gap={totals.axes.coding}
          />
          <AxisRow
            icon="check-square"
            label="Review"
            hint="Not closed yet"
            gap={totals.axes.review}
          />

          {/* The overlap is the whole reason the three numbers above can add
              up to more than the headline. Saying so is cheaper than letting
              someone conclude the card contradicts itself. */}
          {totals.blocked.count > 0 ? (
            <Text className="text-2xs text-muted">
              {rowsAnd(totals.blocked)} blocked in total — the axes overlap:{" "}
              {totals.overlap.oneAxis.count} open on one, {totals.overlap.twoAxes.count} on
              two, {totals.overlap.threeAxes.count} on all three.
            </Text>
          ) : null}

          {totals.reconstructed.inScope.count > 0 ? (
            <FootLine
              icon="archive"
              title={`Reconstructed history · ${rowsAnd(totals.reconstructed.inScope)}`}
              body={`Rebuilt from spreadsheets rather than watched as they happened. ${totals.reconstructed.publishable.count} green, ${totals.reconstructed.blocked.count} still blocked — they publish flagged as reconstructions.`}
            />
          ) : null}

          {totals.codingExempt.count > 0 ? (
            <FootLine
              icon="clock"
              title={`Outside the coding policy · ${rowsAnd(totals.codingExempt)}`}
              body="Spend posted before the coding policy date owes no substantiation record, so it is not counted in the coding gap above."
            />
          ) : null}

          {data.truncated ? (
            <FootLine
              icon="alert-circle"
              title="Partial scan"
              body="This period holds more transactions than one read returns; the figures above are a floor, not the total."
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One axis line: how many rows and dollars are still open on it. A green
 *  axis keeps its row rather than disappearing — "0" is the number the ED is
 *  looking for, and a missing line doesn't say it. */
function AxisRow({
  icon,
  label,
  hint,
  gap,
}: {
  icon: "paperclip" | "edit-3" | "check-square";
  label: string;
  hint: string;
  gap: Gap;
}) {
  const clear = gap.count === 0;
  return (
    <View className="flex-row items-center gap-3">
      <Icon name={icon} size={14} color={clear ? colors.success : colors.warn} />
      <View className="flex-1">
        <Text className="text-xs font-semibold text-ink">{label}</Text>
        <Text className="text-2xs text-muted">{hint}</Text>
      </View>
      <View className="items-end">
        <Text className={`text-xs font-semibold ${clear ? "text-success" : "text-ink"}`}>
          {gap.count}
        </Text>
        <Money cents={gap.cents} className="text-2xs text-muted" />
      </View>
    </View>
  );
}

function FootLine({
  icon,
  title,
  body,
}: {
  icon: "archive" | "clock" | "alert-circle";
  title: string;
  body: string;
}) {
  return (
    <View className="flex-row gap-2 rounded-lg bg-sunken p-2">
      <Icon name={icon} size={13} color={colors.muted} />
      <View className="flex-1">
        <Text className="text-2xs font-semibold text-ink">{title}</Text>
        <Text className="text-2xs text-muted">{body}</Text>
      </View>
    </View>
  );
}
