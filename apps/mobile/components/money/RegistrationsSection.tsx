/**
 * REGISTRATIONS on a project's money page — who paid to be in the class, what
 * they paid, and who got a scholarship.
 *
 * READ ONLY, and there is deliberately NO "+ Add" affordance. The owner,
 * 2026-08-10: "there would need to be a course registration page where we can
 * collect payments… I don't want people to manually record payments, I want it
 * all to flow through the system." A hand-entry button here would be the exact
 * thing that was asked not to exist, and every row it produced would be a claim
 * about money with no processor behind it. Rows arrive from the checkout that
 * collected them (today: the one-time Givebutter backfill).
 *
 * ── WHY THIS DOESN'T TOUCH THE BUDGET BAR ───────────────────────────────────
 * Money IN is a SECOND AXIS, and the bar above stays spend-vs-authorisation.
 * The reasoning lives with the arithmetic, in
 * `packages/shared/src/registrations.ts#netCostCents` — read it there before
 * "fixing" the bar to include income.
 *
 * Refunded and comped rows are shown, greyed, with the reason beneath them. They
 * are NOT revenue (see `summarizeRegistrations`), but leaving them out would
 * make the project's own page unable to say that half the cohort attended on a
 * scholarship — which is the thing the owner asked to be able to see.
 */
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  formatCents,
  netCostCents,
  registrationCountLine,
} from "@events-os/shared";
import { Card, SectionHeader } from "../ui";
import { Money } from "../finance/dashboard/parts";
import {
  refundsAreScholarships,
  registrationDayLabel,
  registrationStatusLabel,
} from "./registrationDisplay";

type RegistrationData = FunctionReturnType<typeof api.registrations.forProject>;
type RegistrationRow = RegistrationData["rows"][number];

export function RegistrationsSection({
  projectId,
  spentCents,
}: {
  projectId: string;
  /** `refMoney.totalActualCents` — the spend the net-cost line sets this
   *  income against. Passed in rather than re-queried so the two numbers on
   *  screen are provably the same number. */
  spentCents: number;
}) {
  const data = useQuery(api.registrations.forProject, { projectId });

  // Nothing to say — a project with no registrations shows no section at all,
  // rather than an empty state inviting someone to add one (there is no add).
  if (data === undefined || data.rows.length === 0) return null;

  const { rows, collectedCents } = data;
  const countLine = registrationCountLine(data, refundsAreScholarships(rows));
  const netCents = netCostCents(spentCents, collectedCents);

  return (
    <>
      <SectionHeader title="Registrations" count={rows.length} />
      <Card padding="none">
        <View className="border-b border-border px-4 py-3">
          <Text className="text-sm text-muted">
            <Money cents={collectedCents} className="text-sm font-semibold text-ink" />
            {" collected"}
            {countLine ? ` · ${countLine}` : ""}
          </Text>
        </View>
        {rows.map((r, i) => (
          <RegistrationRowView key={r.id} row={r} first={i === 0} />
        ))}
      </Card>

      {/* ── Net cost — the second axis, stated as its own number. Never folded
            into the budget bar above; see `netCostCents`. ─────────────────── */}
      <View className="mt-3 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-3 shadow-card">
        <View className="flex-1">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Net cost
          </Text>
          <Text className="mt-0.5 text-xs text-muted">
            {formatCents(spentCents)} spent − {formatCents(collectedCents)} collected
          </Text>
        </View>
        <Money
          cents={netCents}
          className={`text-lg font-semibold ${netCents < 0 ? "text-success" : "text-ink"}`}
        />
      </View>
    </>
  );
}

/**
 * TWO LINES, NOT FOUR COLUMNS — and the second line is why.
 *
 * This started as the four-column table the approved sketch draws, which is
 * right on a wide screen and wrong on a phone. Measured at 390px: the status
 * column got an 80px box and `"refunded — scholarship"` needs 133px, so it
 * rendered as `"refunde…"` — and so did a plain `"refunded"`. A SCHOLARSHIP AND
 * AN ORDINARY CANCELLATION BECAME INDISTINGUISHABLE, which is precisely the
 * distinction this section exists to show; the one column carrying the meaning
 * was the one that lost.
 *
 * The fix is the shape `MoneyView`'s own `TxnRow` already uses two components
 * down this file: identity on the first line, its qualifiers on the second,
 * amount held right. The reason now gets the row's full width instead of a
 * quarter of it.
 *
 * Same 390px measurement after: the second line gets a 298px box and needs 298
 * — the full `"Jan 26 · refunded — scholarship"` fits, and a plain
 * `"Jan 29 · refunded"` is now plainly a different thing.
 *
 * WHAT GETS SACRIFICED WHEN SOMETHING MUST: the NAME truncates, never the
 * reason. A name is recoverable — from the amount, the date, the person sitting
 * next to you. "Was this a scholarship or a cancellation" is recoverable from
 * nothing on this screen, and it is the question the owner asked for. Verified
 * with a 42-character name at 390px: the name clips (305 needed into 298) and
 * the reason under it is untouched, which is the trade working as designed.
 *
 * IF YOU RESTORE THE COLUMNS, measure at 390px before you do. Reasoning about
 * this one is how it shipped wrong the first time.
 */
function RegistrationRowView({
  row,
  first,
}: {
  row: RegistrationRow;
  first: boolean;
}) {
  const earned = row.status === "paid";
  return (
    <View
      className={`flex-row items-center justify-between gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <View className="flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {row.name}
        </Text>
        {/* Date and reason share the full row width minus the amount. The
            reason is LAST so that if anything ever does clip here, it clips
            after the word that matters rather than before it. */}
        <Text
          className={`text-xs ${earned ? "text-muted" : "text-faint"}`}
          numberOfLines={1}
        >
          {registrationDayLabel(row.registeredAt)} · {registrationStatusLabel(row)}
        </Text>
      </View>
      <Text
        className={`text-sm ${earned ? "font-semibold text-ink" : "text-muted"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(row.amountCents)}
      </Text>
    </View>
  );
}
