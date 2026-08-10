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
 * Refunded and comped rows are shown, greyed, with the reason beside them. They
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
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
        {row.name}
      </Text>
      <Text className="w-20 text-xs text-muted" numberOfLines={1}>
        {registrationDayLabel(row.registeredAt)}
      </Text>
      <Text
        className={`w-20 text-right text-sm ${earned ? "font-semibold text-ink" : "text-muted"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(row.amountCents)}
      </Text>
      <Text
        className={`flex-1 text-right text-xs ${earned ? "text-muted" : "text-faint"}`}
        numberOfLines={1}
      >
        {registrationStatusLabel(row)}
      </Text>
    </View>
  );
}
