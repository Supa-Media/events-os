/**
 * Finance dashboard shared parts — the small presentational building blocks the
 * three perspective views (central / chapter / member) compose from, plus a
 * local error boundary that lets a finance query that throws (e.g. the caller
 * lacks a finance-role grant, or `dashboardCentral` rejecting a non-central
 * viewer) degrade to a friendly fallback instead of unmounting the screen.
 *
 * All money is integer cents rendered through `formatCents`; amounts use
 * tabular figures and right-align in tables. Direction is carried by `flow`
 * (never a sign in the data), so `SignedMoney` prints the −/+ for display only.
 */
import { Component, type ReactNode } from "react";
import { Text, View, Pressable } from "react-native";
import { formatCents, type TransactionFlow } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { Icon, type BadgeTone } from "../../ui";

// ── Error boundary ───────────────────────────────────────────────────────────
/**
 * Catches a render-time throw from a Convex `useQuery` in its subtree. Finance
 * reads gate on a `financeRoles` grant, so a viewer without one makes the query
 * throw a `ConvexError`; this keeps that from blanking the whole screen. On the
 * first catch it calls `onError` (used by the central probe to learn "not
 * central") and renders `fallback`. It does not auto-retry — finance-role
 * errors aren't transient — but remounting via a `key` resets it.
 */
export class FinanceBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; onError?: (err: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onError?.(err);
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

// ── Money ────────────────────────────────────────────────────────────────────
const TABULAR = { fontVariant: ["tabular-nums" as const] };

/** Plain formatted cents with tabular figures. */
export function Money({
  cents,
  className = "text-ink",
}: {
  cents: number;
  className?: string;
}) {
  return (
    <Text className={className} style={TABULAR}>
      {formatCents(cents)}
    </Text>
  );
}

/**
 * A charge/credit with its direction shown as a sign: outflow prints `−$…` in
 * ink, inflow `+$…` in green, a transfer stays neutral. The data itself is
 * always a non-negative amount + a `flow`.
 */
export function SignedMoney({
  cents,
  flow,
  className = "",
}: {
  cents: number;
  flow: TransactionFlow;
  className?: string;
}) {
  const sign = flow === "outflow" ? "−" : flow === "inflow" ? "+" : "";
  const tone =
    flow === "inflow" ? "text-success" : flow === "transfer" ? "text-muted" : "text-ink";
  return (
    <Text className={`${tone} ${className}`} style={TABULAR}>
      {sign}
      {formatCents(cents)}
    </Text>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────
export function TileRow({ children }: { children: ReactNode }) {
  return <View className="mb-2 flex-row flex-wrap gap-3">{children}</View>;
}

/** A single KPI tile: label · big value · meta. */
export function Tile({
  label,
  value,
  meta,
  valueClassName = "text-ink",
}: {
  label: string;
  value: string;
  meta?: string;
  valueClassName?: string;
}) {
  return (
    <View className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text
        className={`font-display text-2xl ${valueClassName}`}
        style={TABULAR}
        numberOfLines={1}
      >
        {value}
      </Text>
      {meta ? <Text className="text-xs text-muted">{meta}</Text> : null}
    </View>
  );
}

// ── Bars ─────────────────────────────────────────────────────────────────────
/**
 * A spent-of-budget bar. Fills brand accent while healthy, amber once the
 * budget's status is `warn` (≥80%), and danger red when overspent (≥100%).
 */
export function BudgetBar({
  pct,
  status,
}: {
  pct: number;
  status: "ok" | "warn";
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fill =
    pct >= 100 ? colors.danger : status === "warn" ? colors.warn : colors.accent;
  return (
    <View className="h-2 w-full overflow-hidden rounded-pill bg-sunken">
      <View
        className="h-full rounded-pill"
        style={{ width: `${clamped}%`, backgroundColor: fill }}
      />
    </View>
  );
}

/** A thin proportion bar (per-category / per-chapter breakdowns). */
export function MiniBar({
  barPct,
  color = colors.accent,
}: {
  barPct: number;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, barPct));
  return (
    <View className="h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
      <View
        className="h-full rounded-pill"
        style={{ width: `${clamped}%`, backgroundColor: color }}
      />
    </View>
  );
}

// ── Chips ────────────────────────────────────────────────────────────────────
/** A muted rounded chip for a budget cadence / small meta tag. */
export function Chip({ label }: { label: string }) {
  return (
    <View className="self-start rounded-pill bg-sunken px-2 py-0.5">
      <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
    </View>
  );
}

/** The status → Badge tone map for a transaction. */
export function txnStatusTone(status: string): { tone: BadgeTone; label: string } {
  switch (status) {
    case "reconciled":
      return { tone: "success", label: "Reconciled" };
    case "categorized":
      return { tone: "info", label: "Coded" };
    case "excluded":
      return { tone: "neutral", label: "Excluded" };
    default:
      return { tone: "warn", label: "Needs review" };
  }
}

// ── Month stepper ────────────────────────────────────────────────────────────
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A ‹ Month Year › pill that drives the dashboard's {year, month} args. In
 * `"ytd"` mode `month` is the THROUGH-month (the stepper still selects it) and
 * the label reads "YTD · {Month} {Year}" to signal the cumulative range.
 */
export function MonthStepper({
  year,
  month,
  onChange,
  period = "month",
}: {
  year: number;
  month: number;
  onChange: (next: { year: number; month: number }) => void;
  period?: DashPeriodMode;
}) {
  function step(delta: number) {
    const idx = (month - 1 + delta + 12) % 12;
    const yearDelta = Math.floor((month - 1 + delta) / 12);
    onChange({ year: year + yearDelta, month: idx + 1 });
  }
  const label =
    period === "ytd"
      ? `YTD · ${MONTHS[month - 1]} ${year}`
      : `${MONTHS[month - 1]} ${year}`;
  return (
    <View className="flex-row items-center self-start rounded-pill border border-border-strong bg-raised">
      <Pressable
        onPress={() => step(-1)}
        hitSlop={6}
        className="rounded-l-pill px-2.5 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="chevron-left" size={16} color={colors.muted} />
      </Pressable>
      <Text className="min-w-[140px] px-1 text-center text-sm font-semibold text-ink">
        {label}
      </Text>
      <Pressable
        onPress={() => step(1)}
        hitSlop={6}
        className="rounded-r-pill px-2.5 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="chevron-right" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

// ── Month / YTD period toggle ────────────────────────────────────────────────
export type DashPeriodMode = "month" | "ytd";

/**
 * A compact Month / YTD segmented toggle (matches the `PerspectiveSwitch`
 * styling) that flips the dashboard between the selected month and the
 * cumulative year-to-date range through it. Sits next to the `MonthStepper`.
 */
export function PeriodSwitch({
  value,
  onChange,
}: {
  value: DashPeriodMode;
  onChange: (p: DashPeriodMode) => void;
}) {
  const options: { key: DashPeriodMode; label: string }[] = [
    { key: "month", label: "Month" },
    { key: "ytd", label: "YTD" },
  ];
  return (
    <View className="flex-row items-center gap-0.5 self-start rounded-pill border border-border bg-sunken p-0.5">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            className={`rounded-pill px-3 py-1 ${active ? "bg-raised shadow-card" : ""}`}
          >
            <Text
              className={`text-sm font-semibold ${active ? "text-accent" : "text-muted"}`}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Segmented "Preview as" control ───────────────────────────────────────────
export type Perspective = "central" | "chapter" | "member";

/** The prototype's "Preview as" segmented switch. Options are caller-supplied
 *  (the Central segment only appears for central viewers). */
export function PerspectiveSwitch({
  value,
  options,
  onChange,
}: {
  value: Perspective;
  options: { key: Perspective; label: string }[];
  onChange: (p: Perspective) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
        Preview as
      </Text>
      <View className="flex-row items-center gap-0.5 rounded-pill border border-border bg-sunken p-0.5">
        {options.map((o) => {
          const active = o.key === value;
          return (
            <Pressable
              key={o.key}
              onPress={() => onChange(o.key)}
              className={`rounded-pill px-3 py-1 ${active ? "bg-raised shadow-card" : ""}`}
            >
              <Text
                className={`text-sm font-semibold ${active ? "text-accent" : "text-muted"}`}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── AI auto-coding banner ────────────────────────────────────────────────────
/** The static "AI auto-coding is on" explainer strip from the prototype. */
export function AiCodingBanner() {
  return (
    <View className="mb-1 flex-row items-start gap-3 rounded-lg border border-lavender/60 bg-lavender/20 px-4 py-3">
      <View className="mt-0.5">
        <Icon name="sparkles" size={16} color={colors.statPurple} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink">AI auto-coding is on</Text>
        <Text className="mt-0.5 text-sm text-muted">
          New charges get a suggested fund, category & event/project from the
          card, the time, and what's on the calendar that week — review it in
          Reconcile and hit Accept. Nothing is coded automatically.
        </Text>
      </View>
    </View>
  );
}
