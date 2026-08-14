/**
 * BUDGETS · one glance card, now with the drop-down.
 *
 * Founder, 2026-08-14: "the budgeting section leaves a lot to be desired. It
 * just gives an amount. Doesn't give details, doesn't give any concrete
 * things. For events, you can't even click to the event, go to the money page
 * for a project. You can't even go to where the project details are… we should
 * just be able to drop down and see the different expenses per budget. It
 * should just be a lot more interactable."
 *
 * The card that shipped before this was a `<View>`: a name, "spent of cap", a
 * meter, and no affordances at all — not a link, not a press target, no way to
 * reach the event it belonged to or the charges that produced the number.
 * Three things change here and nothing else:
 *
 *  1. THE ROW IS A DISCLOSURE. Pressing anywhere on the header expands it in
 *     place (chevron rotates) — no navigation, no modal, no losing your place
 *     in a list of twenty budgets. The expense query is only subscribed while
 *     expanded (`"skip"` otherwise), so a screen full of collapsed cards costs
 *     exactly what it did before.
 *  2. THE REF IS REACHABLE. An event/project budget offers "Open event" /
 *     "Open project" AND a direct "Money" link into that ref's own money
 *     surface (`/event/[id]?tab=money`, the ONE money view per `event/[id]`'s
 *     own tab param) — the two destinations the founder named by name. Both
 *     are gated on the server having resolved a LIVE ref (`refKind != null`),
 *     so a budget whose event was deleted shows no link rather than a 404.
 *  3. THE NUMBER HAS PARTS. Category mini-bars plus the individual charges —
 *     date, merchant, who spent it, whether a receipt is attached — summing to
 *     the exact figure in the header, because the server computes both with
 *     the same rule (`budgetGlance.expenses`, which reuses the card's own
 *     window; see that file's module doc).
 *
 * "Full detail" appears only when the server says this caller can actually
 * open `/finances/budgets/[id]` (`canOpenDetail` — that page is finance-viewer
 * gated). A no-seat cardholder gets the drop-down and the ref links and no
 * dead end.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { Meter } from "../dashboard/Meter";
import { MiniBar, txnStatusTone } from "../dashboard/parts";

type GlanceRow = FunctionReturnType<
  typeof api.finances.budgetsGlance
>["oneTime"][number];
type Expenses = NonNullable<
  FunctionReturnType<typeof api.budgetGlance.expenses>
>;
type ExpenseLine = Expenses["lines"][number];

/** The recurring cadence window's plain-words label ("this month" etc.). */
const CADENCE_LABELS: Record<string, string> = {
  monthly: "this month",
  quarterly: "this quarter",
  yearly: "this year",
};

export function BudgetGlanceCard({ row }: { row: GlanceRow }) {
  const [open, setOpen] = useState(false);
  const over = row.remainingCents < 0;
  const window = row.type === "recurring" ? CADENCE_LABELS[row.cadence] : null;

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      {/* ── Header: the whole thing is the disclosure control ─────────────── */}
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${row.name}, ${formatCents(row.spentCents)} of ${formatCents(row.capCents)} spent`}
        className="p-3 active:opacity-70"
      >
        <View className="mb-1 flex-row items-baseline gap-2">
          <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
            {row.name}
          </Text>
          {row.dateLabel ? (
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {row.dateLabel}
            </Text>
          ) : null}
          <Icon
            name={open ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.muted}
          />
        </View>
        <View className="mb-1.5 flex-row items-baseline justify-between gap-2">
          <Text className="text-sm text-muted">
            {formatCents(row.spentCents)} of {formatCents(row.capCents)}
            {window ? ` ${window}` : " spent"}
          </Text>
          <Text
            className={`text-sm font-semibold ${over ? "text-danger" : "text-success"}`}
          >
            {over
              ? `${formatCents(-row.remainingCents)} over`
              : `${formatCents(row.remainingCents)} left`}
          </Text>
        </View>
        <Meter pct={row.pct} size="sm" />
      </Pressable>

      {open ? <BudgetGlanceDrawer row={row} /> : null}
    </View>
  );
}

/**
 * The expanded body. Its own component so the `useQuery` subscription is
 * MOUNTED with the drawer rather than living on every collapsed card behind a
 * `"skip"` — twenty collapsed budgets should cost twenty rows of data, not
 * twenty idle subscriptions waiting to be un-skipped.
 */
function BudgetGlanceDrawer({ row }: { row: GlanceRow }) {
  const detail = useQuery(api.budgetGlance.expenses, {
    budgetId: row.id as Id<"budgets">,
  });

  if (detail === undefined) {
    return (
      <View className="border-t border-border px-3 py-4">
        <Text className="text-xs text-muted">Loading charges…</Text>
      </View>
    );
  }
  if (detail === null) {
    // The server declined (no roster row, a draft budget, another chapter's).
    // Say what the reader can act on, not which of those it was.
    return (
      <View className="border-t border-border px-3 py-4">
        <Text className="text-xs text-muted">
          The charges behind this budget aren&apos;t available to you.
        </Text>
      </View>
    );
  }

  return (
    <View className="border-t border-border">
      <BudgetLinks detail={detail} />
      {detail.categories.length > 0 ? (
        <View className="gap-2 border-t border-border px-3 py-3">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Where it went
          </Text>
          {detail.categories.map((c) => (
            <View key={c.name} className="gap-1">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
                  {c.name}
                </Text>
                <Text
                  className="text-xs font-semibold text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {formatCents(c.spentCents)}
                </Text>
              </View>
              <MiniBar barPct={c.barPct} />
            </View>
          ))}
        </View>
      ) : null}

      <View className="border-t border-border">
        <View className="flex-row items-center justify-between gap-2 px-3 pb-1 pt-3">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Charges
          </Text>
          <Text className="text-2xs text-muted">
            {detail.lineTotalCount > detail.lines.length
              ? `${detail.lines.length} of ${detail.lineTotalCount}`
              : detail.lineTotalCount}
            {detail.windowLabel ? ` · ${detail.windowLabel}` : ""}
          </Text>
        </View>
        {detail.lines.length === 0 ? (
          <Text className="px-3 pb-3 text-xs text-muted">
            Nothing has been charged to this budget
            {detail.windowLabel ? ` ${detail.windowLabel}` : " yet"}.
          </Text>
        ) : (
          <View className="pb-1">
            {detail.lines.map((line) => (
              <ExpenseRow key={line.id} line={line} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The deep links the founder asked for, in one row. `refKind` is non-null only
 * for a LIVE event/project ref (the server drops it for a deleted one), so
 * every link here is guaranteed to resolve.
 *
 * "Money" targets the ref's OWN money surface. An event's is a TAB
 * (`?tab=money` on its detail route — the param is also what makes the link
 * shareable and back-button-safe). A project renders its `MoneyView` inline,
 * so `?section=money` scrolls to it instead (see `project/[id].tsx`). Both
 * land the reader on the money rather than at the top of a long page, which
 * is the whole point of the link.
 */
function BudgetLinks({ detail }: { detail: Expenses }) {
  const router = useRouter();
  const hasRef = detail.refKind != null && detail.scopeRefId != null;
  if (!hasRef && !detail.canOpenDetail) return null;

  return (
    <View className="flex-row flex-wrap gap-2 px-3 py-3">
      {hasRef ? (
        <LinkChip
          icon={detail.refKind === "event" ? "calendar" : "folder"}
          label={detail.refKind === "event" ? "Open event" : "Open project"}
          onPress={() =>
            router.push(`/${detail.refKind}/${detail.scopeRefId}` as never)
          }
        />
      ) : null}
      {hasRef ? (
        <LinkChip
          icon="dollar-sign"
          label="Money"
          onPress={() =>
            router.push(
              detail.refKind === "event"
                ? (`/event/${detail.scopeRefId}?tab=money` as never)
                : (`/project/${detail.scopeRefId}?section=money` as never),
            )
          }
        />
      ) : null}
      {detail.canOpenDetail ? (
        <LinkChip
          icon="external-link"
          label="Full detail"
          onPress={() => router.push(`/finances/budgets/${detail.id}` as never)}
        />
      ) : null}
    </View>
  );
}

function LinkChip({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      className="flex-row items-center gap-1.5 rounded-pill border border-border bg-sunken px-2.5 py-1 active:opacity-70"
    >
      <Icon name={icon} size={12} color={colors.accent} />
      <Text className="text-xs font-medium text-accent">{label}</Text>
    </Pressable>
  );
}

/** One charge: what it was, when, who, and whether it has a receipt. */
function ExpenseRow({ line }: { line: ExpenseLine }) {
  const { tone, label } = txnStatusTone(line.status);
  const meta = [
    formatDate(line.postedAt),
    line.personName,
    line.categoryName,
  ].filter(Boolean) as string[];
  return (
    <View className="flex-row items-center gap-3 border-t border-border px-3 py-2.5">
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-ink" numberOfLines={1}>
          {line.merchantName ?? line.description ?? "Charge"}
        </Text>
        <Text className="text-2xs text-muted" numberOfLines={1}>
          {meta.join(" · ")}
        </Text>
      </View>
      {line.hasReceipt ? (
        <Icon name="paperclip" size={12} color={colors.success} />
      ) : null}
      <View className="items-end gap-1">
        <Text
          className={`text-xs font-semibold ${line.flow === "inflow" ? "text-success" : "text-ink"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {line.flow === "outflow" ? "−" : line.flow === "inflow" ? "+" : ""}
          {formatCents(line.amountCents)}
        </Text>
        <Badge label={label} tone={tone} />
      </View>
    </View>
  );
}
