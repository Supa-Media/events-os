/**
 * DOES IT ADD UP? — the panel that answers the only question this page exists
 * for, in the order a person asks it.
 *
 * The founder, 2026-08-08:
 *
 *   "the whole point of this section is to see whether our books match what's
 *    in the bank account. So I just want things put in a format that shows me —
 *    hey, if we take all the pending, all the stuff in payout, and all the
 *    stuff in Stripe, and all the stuff in the account, we're still missing
 *    $50. Or we don't have this amount of money, so I know I need to go
 *    reconcile it and find out, oh, was there a payment that wasn't attributed
 *    to the right book. But right now it's just very abstract to get that
 *    information."
 *
 * Every number he needed was already on the page. What was missing was the
 * SUBTRACTION — the page laid out four columns and left the arithmetic, and
 * therefore the conclusion, as an exercise. So this panel states one figure
 * prominently and the two totals it came from underneath, rather than adding a
 * fifth column to a table nobody could total by eye.
 *
 * ── WHY THE WORKING IS FOLDED AWAY (2026-08-09) ──────────────────────────────
 * The founder again, a day later: "it takes up so much space, and feels like
 * clutter, please declutter."
 *
 * Every piece of what follows was added for a reason and each is defensible on
 * its own — but stacked, the piles, the two winding-down vendors, the
 * where-to-look leads and their explanations ran well past a full screen and
 * buried the one figure the section exists to deliver. Length is not the
 * complaint; RATIO is. A panel whose answer is one sentence should not open
 * with a page of evidence for it.
 *
 * So the default view is the VERDICT and the two totals it came from, and
 * everything else — the pile breakdown, the winding-down group with Relay's
 * editor, the org-wide explainer, the where-to-look leads — sits behind "Show
 * the working". NOTHING was deleted: the piles are what make the figure
 * checkable, and the leads are what turn a gap into a next action. They are one
 * tap away, under a label that says out loud that there is more.
 *
 * Three things the fold deliberately does NOT hide, because they are what stop
 * the collapsed card from being an oracle:
 *
 *   · the two totals, on one line — a number nobody can check is not evidence.
 *   · the "as of" stamp and Refresh — a stale figure that looks fresh is the
 *     exact failure this panel's mount refresh exists to prevent, and hiding
 *     the stamp behind a tap would reintroduce it.
 *   · a warning when Relay's hand-typed balance is stale or has never been
 *     recorded — that is a hole in the total on display, so it belongs beside
 *     the total, not inside the thing you have to open to find it.
 *
 * ── THREE THINGS IT REFUSES TO DO ────────────────────────────────────────────
 *
 * 1. IT NEVER SHOWS THE GAP AS A BARE ABSOLUTE VALUE. Which way it leans IS
 *    the diagnosis: more cash than the books explain means income nobody
 *    recorded; more books than cash means something is counted twice or was
 *    never really spent. Those send a treasurer to opposite ends of the app,
 *    and "$5,871.68 difference" sends them nowhere.
 *
 *    The condense raised the stakes on this, so the direction was promoted:
 *    it used to live only in the sentence UNDER the figure, and now it is a
 *    label ABOVE it, read first. The magnitude is still displayed positive —
 *    a minus sign is not a diagnosis, and "−$614.68" reads as an accounting
 *    convention rather than as "the books claim money that is nowhere".
 *
 * 1b. AND ZERO IS NOT A GAP OF ZERO. When the books reconcile exactly the card
 *    says so in plain words and a success tone, and shows no figure at all —
 *    "$0.00 unaccounted for" in an alarm colour is an alarm about nothing, and
 *    it trains the reader to ignore the colour that matters.
 *
 * 2. IT NEVER CALLS A GAP AN ERROR. A difference can be entirely legitimate —
 *    which is why the known-legitimate components are netted out first (pending
 *    is added back to the bank side, money at Stripe is counted as money) and
 *    in-kind revenue is named rather than silently adjusted. What is left is
 *    "unaccounted for", which is a statement about our knowledge, not an
 *    accusation.
 *
 * 3. IT NEVER STOPS AT THE NUMBER. A gap the reader can't act on is just a
 *    worse version of the four columns. "Where to look" points at the tools
 *    that already exist for exactly these findings — the per-book duplicate
 *    scan and counted-as-zero list behind a tap on any row of Account balances,
 *    which now sits directly above this panel. Folding those leads into the
 *    working does not weaken this: they are a tap away and the toggle names
 *    them, whereas before the condense they were four scrolls away and named
 *    nothing.
 *
 * ── WHY IT REFRESHES ON MOUNT ────────────────────────────────────────────────
 * The founder again: "I need it to sync every time I open the page." Balances
 * used to move only when the morning cron ran, so this panel would confidently
 * reconcile the books against a bank figure from 5am. The mount effect calls
 * `refreshBalancesNow`, which re-reads the balances (Increase, Stripe,
 * Givebutter) and asks Stripe to re-pull the Relay transaction feed — and
 * NOTHING else. It is not the engine, it books nothing and moves no cash. Every
 * throttle lives on the server, where it survives remounts and knows about other
 * viewers; see `reconciliation.ts#claimBalanceSnapshot` and `#claimFcRefresh`.
 *
 * ── THE TWO PILES ON THEIR WAY OUT ───────────────────────────────────────────
 * Givebutter and Relay both still hold real money and are both being deprecated
 * ("we plan to deprecate both givebutter and relay soon but for now it still
 * holds some of our funds" — founder, 2026-08-08). They get their own labelled
 * group rather than sitting anonymously among the permanent accounts, because a
 * treasurer reading this in three months needs to know these are winding down;
 * a comment in the source is not where they will find that out.
 *
 * The two are NOT the same kind of number, and the panel does not pretend
 * otherwise. Givebutter's is fetched (derived from its transaction feed, since
 * it publishes no balance endpoint). Relay's is TYPED BY A PERSON, because Relay
 * has no balance API at all — so that row shows who stated it, when they say it
 * was true, and says so out loud once it is old enough to doubt. Relay's
 * TRANSACTIONS do sync live via Stripe Financial Connections, which is a
 * separate freshness from its balance and is reported separately for exactly
 * that reason: a feed that synced a minute ago is no evidence at all that a
 * balance typed three weeks ago is still right.
 *
 * Both live behind "Show the working" after the condense — but the STALENESS
 * of Relay's typed figure does not, because it is a defect in the total the
 * collapsed card is showing. See `relayWarning` below.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  Icon,
  SectionHeader,
  TextField,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { condenseVerdict } from "./reconciliationVerdict";

/** `Aug 8, 2:14 PM` in the org's timezone. */
function stamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `Aug 8` — for a figure whose time of day is noise, like a stated balance. */
function day(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}

/**
 * How old a hand-entered Relay balance may get before the panel says so.
 *
 * A typed number does not refresh itself, and the failure mode is specific: it
 * silently ages into fiction while sitting in a total that looks as
 * authoritative as the machine-read figures beside it. Two weeks is roughly a
 * statement cycle — long enough not to nag, short enough that a stale figure
 * gets called out well before it can move the gap by a meaningful amount.
 */
const RELAY_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function Row({
  label,
  hint,
  value,
  strong,
  faint,
}: {
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
  faint?: boolean;
}) {
  return (
    <View className="flex-row items-baseline gap-3 py-1">
      <View className="min-w-0 flex-1">
        <Text
          className={`text-sm ${
            strong ? "font-semibold text-ink" : faint ? "text-faint" : "text-muted"
          }`}
        >
          {label}
        </Text>
        {hint ? <Text className="text-2xs text-faint">{hint}</Text> : null}
      </View>
      <Text
        className={`text-sm ${strong ? "font-semibold text-ink" : "text-ink"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The Relay balance, stated by a person.
 *
 * Every other figure in this panel is fetched; this one is typed, because Relay
 * exposes no balance API (its TRANSACTIONS do sync live, through Stripe
 * Financial Connections — it is only the account total that has to be read off a
 * statement). So the row carries the things a fetched number gets for free and a
 * typed one does not: when it was true, who said so, and a warning once it is
 * old enough to doubt.
 *
 * Editing in place rather than behind a settings screen is the point — a figure
 * the reader has just been told is three weeks old should be fixable without
 * leaving the sentence that told them.
 */
function RelayBalanceEditor({
  balanceCents,
  asOf,
  setByName,
}: {
  balanceCents: number | null;
  asOf: number | null;
  setByName: string | null;
}) {
  const setRelayBalance = useMutation(api.reconciliation.setRelayBalance);
  const { run, toast, dismiss } = useActionRunner();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const stale = asOf != null && Date.now() - asOf > RELAY_STALE_AFTER_MS;

  function open() {
    // Seed with the current figure so "update" is an edit, not a re-type.
    setDraft(balanceCents == null ? "" : (balanceCents / 100).toFixed(2));
    setEditing(true);
  }

  function save() {
    const raw = draft.trim().replace(/^\$/, "").replace(/,/g, "");
    const dollars = Number(raw);
    if (!raw || !Number.isFinite(dollars)) {
      void run(
        () =>
          Promise.reject(
            new Error("Enter the balance in dollars, e.g. 56.93."),
          ),
        { errorTitle: "That isn't a number" },
      );
      return;
    }
    // Round at the boundary, once. Float dollars in, integer cents everywhere
    // after — the same discipline the Givebutter and Stripe amounts follow.
    const cents = Math.round(dollars * 100);
    void run(() => setRelayBalance({ balanceCents: cents }), {
      errorTitle: "Couldn't record the Relay balance",
      onSuccess: () => setEditing(false),
    });
  }

  return (
    <View className="py-1">
      <View className="flex-row items-baseline gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-sm text-muted">In Relay</Text>
          <Text className="text-2xs text-faint">
            {balanceCents == null
              ? "No balance recorded — Relay has no balance API, so this one is read off the account and typed in"
              : `Stated${setByName ? ` by ${setByName}` : ""}${
                  asOf ? `, true as of ${day(asOf)}` : ""
                }`}
          </Text>
        </View>
        <Text
          className={`text-sm ${balanceCents == null ? "text-faint" : "text-ink"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {balanceCents == null ? "—" : formatCents(balanceCents)}
        </Text>
      </View>

      {stale && !editing ? (
        <Text className="mt-0.5 text-2xs text-warn">
          This figure is over two weeks old and nothing refreshes it on its own
          — check Relay and update it, or it will keep counting as money we can
          point at long after it moved.
        </Text>
      ) : null}

      {editing ? (
        <View className="mt-2 flex-row items-end gap-2">
          <View className="flex-1">
            <TextField
              label="Relay balance (dollars)"
              keyboardType="decimal-pad"
              value={draft}
              onChangeText={setDraft}
              placeholder="e.g. 56.93"
            />
          </View>
          <Button title="Save" variant="primary" size="sm" onPress={save} />
          <Button
            title="Cancel"
            variant="secondary"
            size="sm"
            onPress={() => setEditing(false)}
          />
        </View>
      ) : (
        <View className="mt-1 flex-row">
          <Button
            title={balanceCents == null ? "Record balance" : "Update"}
            variant="secondary"
            size="sm"
            icon="edit-2"
            onPress={open}
          />
        </View>
      )}
      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}

export function ReconciliationSummary() {
  const summary = useQuery(api.reconciliation.reconciliationSummary, {});
  const refresh = useAction(api.reconciliation.refreshBalancesNow);
  const [refreshing, setRefreshing] = useState(false);
  // Collapsed by default, and NOT persisted. The default view is the answer;
  // opening the working is something you do while investigating one particular
  // gap, not a preference about how the page looks. Remembering it would leave
  // the reader who once went digging staring at a wall of evidence every
  // morning after — which is the state this change exists to undo.
  const [showWorking, setShowWorking] = useState(false);

  // ONE automatic refresh per mount. A ref rather than state because the effect
  // must not re-fire when the refresh's own writes push a new query result down
  // — that is a loop, and a loop here is a loop against Increase and Stripe.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (askedOnOpen.current) return;
    askedOnOpen.current = true;
    // Fire and forget, deliberately. A balance refresh failing is not worth a
    // toast over a page that already renders the (visibly stamped) last-known
    // figures — the server logs it, and the "as of" tells the truth either way.
    void refresh({}).catch(() => {});
  }, [refresh]);

  const onRefresh = () => {
    setRefreshing(true);
    // `force` skips the freshness window: the reader can see the "as of" and
    // has decided it isn't good enough. It does not skip the in-flight lock.
    void refresh({ force: true })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  if (summary === undefined) {
    return (
      <>
        <SectionHeader title="Does it add up?" />
        <Card>
          <Text className="text-sm text-muted">Loading…</Text>
        </Card>
      </>
    );
  }

  // One decision, three cases, unit-tested without a renderer. The sign and the
  // zero-is-not-a-gap rule both live in there; see `reconciliationVerdict.ts`.
  const verdict = condenseVerdict(summary);
  const balanced = verdict.kind === "balanced";
  const unknowable = verdict.kind === "unknowable";
  const cashHigh = verdict.cashHigh;
  const missingLabel = verdict.missingLabel;
  // One source for the callout's colour, so the icon can never disagree with
  // the border and background around it.
  const toneColor = verdict.tone === "success" ? colors.success : colors.warn;
  // Whether the one-clause wind-down footnote applies at all. Same test the
  // working uses for its "on their way out" group: on a deployment with neither
  // vendor there is nothing to caveat, and the sentence would be a lie.
  const showWindingDown =
    summary.givebutterConfigured || summary.relayBalanceCents != null;

  /**
   * The one piece of Relay that does NOT fold away.
   *
   * Everything else about Relay is detail; this is a defect in the total the
   * collapsed card is displaying, and a defect in a figure belongs next to the
   * figure. Two states qualify:
   *
   *  · the typed balance has aged past the point we are willing to vouch for
   *    it, and it is still being counted as money we can point at;
   *  · nobody has ever typed one WHILE Relay's transactions are still syncing,
   *    which proves the account exists and is holding an unknown amount. The
   *    arithmetic deliberately cannot flag this for itself (an unrecorded
   *    balance is indistinguishable from no Relay at all — see
   *    `reconciliationGap.ts#missingTerms`), so the UI has to.
   *
   * The fix for both — Relay's inline editor — is in the working, one tap
   * away, which is why the badge names Relay rather than saying something
   * generic about staleness.
   */
  const relayWarning: string | null =
    summary.relayBalanceCents == null
      ? summary.relayFeedSyncedAt != null
        ? "Relay balance never recorded"
        : null
      : summary.relayBalanceAsOf != null &&
          Date.now() - summary.relayBalanceAsOf > RELAY_STALE_AFTER_MS
        ? "Relay balance over two weeks old"
        : null;

  return (
    <>
      <SectionHeader title="Does it add up?" />
      <Card>
        {/* THE ANSWER — and, by default, very nearly the whole card. Everything
            that used to sit above this block was the evidence for it; it now
            sits below, folded, in the order a reader who doubts the answer
            would actually want it. */}
        <View
          className={`rounded-lg border px-3 py-3 ${
            verdict.tone === "success"
              ? "border-success/40 bg-success/10"
              : "border-warn/40 bg-warn/10"
          }`}
        >
          {balanced ? (
            <>
              <View className="flex-row items-center gap-2">
                <Icon name={verdict.icon} size={16} color={toneColor} />
                <Text className="font-display text-base text-ink">
                  It adds up. The books match the money to the cent.
                </Text>
              </View>
              {/* No figure, deliberately. "$0.00 unaccounted for" is an alarm
                  about nothing, and a reader who sees one learns to discount
                  the colour on the day it means something. */}
              <Text className="mt-0.5 text-sm text-muted">
                Nothing to reconcile right now.
              </Text>
            </>
          ) : unknowable ? (
            <>
              <View className="flex-row items-start gap-2">
                <View className="mt-0.5">
                  <Icon name={verdict.icon} size={16} color={toneColor} />
                </View>
                <Text className="min-w-0 flex-1 font-display text-base text-ink">
                  Can&apos;t say yet — we&apos;ve never read the {missingLabel}{" "}
                  balance.
                </Text>
              </View>
              <Text className="mt-0.5 text-sm text-muted">
                The two sides happen to match, but whatever {missingLabel} is
                holding is missing from the money side, so that isn&apos;t a
                reconciliation. Press Refresh, or wait for the morning run.
              </Text>
            </>
          ) : (
            <>
              {/* DIRECTION FIRST, on its own line and read before the figure.
                  It used to live only in the sentence underneath, which was
                  survivable while the piles were on screen to reason from; in a
                  card this short it is most of the message. The magnitude below
                  stays positive — a minus sign is an accounting convention, not
                  a diagnosis. */}
              {/* THE FULLY-EXPLAINED CASE GETS ITS OWN HEADLINE, not just its
                  own subtitle. "unaccounted for" is a claim, and the moment
                  this panel accounts for the whole difference — a known gift,
                  receipted by us, in transit at the processor — the claim is
                  false. Softening the sentence underneath while the banner
                  still shouted the false thing was this panel's second miss
                  on the same $309.27 (owner report, 2026-08-11): the first
                  was not knowing the answer; the second was knowing it and
                  keeping the alarm on. */}
              {(() => {
                const fullyInFlight =
                  cashHigh &&
                  summary.inFlightGiftCount > 0 &&
                  summary.inFlightGiftCents === verdict.amountCents;
                return (
                  <>
                    <View className="flex-row items-center gap-1.5">
                      <Icon
                        name={fullyInFlight ? "clock" : verdict.icon}
                        size={13}
                        color={fullyInFlight ? colors.muted : toneColor}
                      />
                      <Text
                        className={`min-w-0 flex-1 text-[11px] font-bold uppercase tracking-wide ${
                          fullyInFlight ? "text-muted" : "text-warn"
                        }`}
                      >
                        {fullyInFlight
                          ? "A gift is on its way to the bank"
                          : cashHigh
                            ? "More money than the books explain"
                            : "The books claim more than we can find"}
                      </Text>
                    </View>
                    <Text
                      className="font-display text-xl text-ink"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {formatCents(verdict.amountCents)}{" "}
                      {fullyInFlight ? "in transit" : "unaccounted for"}
                    </Text>
                    <Text className="mt-0.5 text-sm text-muted">
                      {fullyInFlight
                        ? "A bank-transfer gift we've already receipted is still clearing — details under Where to look. It books itself when it settles, and this line goes back to zero."
                        : cashHigh
                          ? "Something came in that was never recorded, or an expense was recorded that never actually left."
                          : "Something is counted twice, or was recorded as spent when it wasn't."}
                    </Text>
                  </>
                );
              })()}
            </>
          )}
        </View>

        {/* The two totals the verdict is the difference between. One line, and
            it stays OUT of the fold on purpose: a conclusion with nothing to
            check it against is an oracle, not a reconciliation, and these two
            are what a treasurer glances at to decide whether the answer is even
            plausible before opening anything. */}
        <View className="mt-3 flex-row flex-wrap items-baseline gap-x-5 gap-y-0.5">
          <Text className="text-sm text-muted">
            Books say{" "}
            <Text
              className="font-semibold text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatCents(summary.bookValueCents)}
            </Text>
          </Text>
          <Text className="text-sm text-muted">
            Money we can point at{" "}
            <Text
              className="font-semibold text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatCents(summary.locatedCents)}
            </Text>
          </Text>
        </View>
        {/* The wind-down, in one clause instead of the two lines it had. It
            still matters — a reader must not take Givebutter and Relay for
            permanent fixtures of where the org's money lives — but it is a
            footnote on a total, not a headline. */}
        {showWindingDown ? (
          <Text className="mt-0.5 text-2xs text-faint">
            Includes Givebutter and Relay — both winding down, both still
            holding our money.
          </Text>
        ) : null}

        {/* The disclosure, deliberately a full-width labelled row rather than a
            bare chevron: someone who has never opened it has to be able to tell
            there is more, and what the more is. */}
        <Pressable
          onPress={() => setShowWorking((w) => !w)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showWorking }}
          accessibilityLabel={
            showWorking
              ? "Hide the working"
              : "Show the working — every pile of money, and where to look"
          }
          className="mt-3 flex-row items-center gap-1.5 border-t border-border pt-2 active:opacity-70 web:hover:opacity-90"
        >
          <Icon
            name={showWorking ? "chevron-up" : "chevron-down"}
            size={14}
            color={colors.muted}
          />
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {showWorking ? "Hide the working" : "Show the working"}
          </Text>
          {showWorking ? null : (
            <Text className="min-w-0 flex-1 text-2xs text-faint">
              every pile of money, and where to look
            </Text>
          )}
        </Pressable>

        {showWorking ? <ReconciliationWorking summary={summary} /> : null}

        {/* Freshness and Refresh never fold. The whole reason this panel
            re-reads balances on mount is that a verdict computed from a 5am
            figure is not a verdict — hiding the stamp behind a tap would put
            that failure straight back, with the card looking authoritative
            while nobody could see how old it is. */}
        <View className="mt-3 flex-row flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
            <Text className="text-2xs text-faint">
              {summary.balancesAsOf
                ? `Balances as of ${stamp(summary.balancesAsOf)}`
                : "Balances have never been fetched"}
            </Text>
            {summary.refreshing ? (
              <Badge label="Syncing…" tone="neutral" icon="refresh-cw" />
            ) : null}
            {summary.truncated ? (
              <Badge
                label="Scan truncated — approximate"
                tone="warn"
                icon="alert-triangle"
              />
            ) : null}
            {relayWarning ? (
              <Badge label={relayWarning} tone="warn" icon="alert-triangle" />
            ) : null}
          </View>
          <Button
            title={refreshing ? "Refreshing…" : "Refresh"}
            variant="secondary"
            size="sm"
            icon="refresh-cw"
            disabled={refreshing}
            onPress={onRefresh}
          />
        </View>
      </Card>
    </>
  );
}

type Summary = FunctionReturnType<
  typeof api.reconciliation.reconciliationSummary
>;

/**
 * THE WORKING — every pile the verdict was computed from, and every lead worth
 * following when it doesn't come out to zero.
 *
 * This is what the 2026-08-09 condense folded away, moved wholesale rather than
 * trimmed. The temptation was to cut it, since length is what the founder
 * complained about. But length was never the problem: a reconciliation figure
 * nobody can decompose is a number you either believe or don't, and "where to
 * look" is the difference between a finding and a chore. What was wrong is that
 * all of it sat ABOVE the answer. Below and folded, it costs a tap and nothing
 * else.
 *
 * It recomputes its own derived flags from `summary` rather than taking eight
 * props. `condenseVerdict` is pure and trivial, the query result is already in
 * hand, and a prop list that long is a standing invitation for the two halves
 * of this panel to start disagreeing about which case they are in.
 */
function ReconciliationWorking({ summary }: { summary: Summary }) {
  const verdict = condenseVerdict(summary);
  const balanced = verdict.kind === "balanced";
  const unknowable = verdict.kind === "unknowable";
  const cashHigh = verdict.cashHigh;
  const stripeMissing = summary.missingTerms.includes("stripe");
  const givebutterMissing = summary.missingTerms.includes("givebutter");
  // The group only earns its space where one of these piles is real: a
  // Givebutter integration, or a Relay balance somebody has recorded. On a
  // deployment with neither, two permanent em-dashes under a "winding down"
  // heading is noise pretending to be information.
  const showWindingDown =
    summary.givebutterConfigured || summary.relayBalanceCents != null;

  return (
    <View className="mt-2 border-t border-border-strong pt-3">
      <Text className="mb-3 text-2xs text-faint">
        Everything the books say the org is worth, against every pile of money
        we can actually point at. Compared across the whole org on purpose:
        every payout lands in central&apos;s account, so central always holds
        cash the chapters earned and a single book&apos;s value never matches
        its own bank. Summed, that cancels out.
      </Text>

      <Row
        label="The books say we have"
        hint="Every book's value added up"
        value={formatCents(summary.bookValueCents)}
        strong
      />

      <View className="mt-3 border-t border-border-strong pt-2">
        <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
          Where that money actually is
        </Text>
        <Row
          label="In the bank"
          hint="Available across every Increase account"
          value={formatCents(summary.bankAvailableCents)}
        />
        <Row
          label="Set aside, not yet posted"
          hint={
            // Named the outbound transfer as an example of money "the ledger
            // hasn't seen" until 2026-08-10, which was backwards for the one
            // kind of transfer this app books before it settles: a reimbursement
            // ACH, whose expense row is written when the payout reaches `paid`
            // while Increase still holds the instruction pending. Those are
            // excluded now — matched by transfer id, never by category — and the
            // hint names the amount whenever there is one, because a total
            // smaller than the bank's own pending figure has to explain itself.
            // The accounts table and its drill-down show the same split.
            summary.bankPendingBookedCents > 0
              ? `Card spend and holds the bank has taken off the available balance but hasn't posted — the ledger hasn't seen them either, so they still count as ours. Excludes ${formatCents(summary.bankPendingBookedCents)} of transfers already sent, which the ledger has already counted as spend.`
              : "Card spend and holds the bank has taken off the available balance but hasn't posted — the ledger hasn't seen them either, so it still counts as ours"
          }
          value={formatCents(summary.bankPendingCents)}
        />
        <Row
          label="Still at Stripe"
          hint={
            stripeMissing
              ? "Never fetched — this total is short by whatever Stripe is holding"
              : "Earned and counted, but not yet paid into any account"
          }
          value={
            stripeMissing
              ? "—"
              : formatCents(
                  (summary.stripeAvailableCents ?? 0) +
                    (summary.stripePendingCents ?? 0),
                )
          }
        />

        {/* ── The two piles on their way out ───────────────────────────────
            Kept together and labelled, so nobody reads them as permanent
            fixtures of the org's money. The collapsed card says that in one
            clause; here is where the two are actually itemised, and where
            Relay's hand-typed figure can be corrected. */}
        {showWindingDown ? (
          <View className="mt-2 border-t border-border pt-2">
            <Text className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
              On their way out
            </Text>
            <Text className="mb-1 text-2xs text-faint">
              Givebutter and Relay are both being wound down. They&apos;re
              listed because they still hold our money, not because they&apos;re
              part of where it&apos;s going.
            </Text>
            {summary.givebutterConfigured ? (
              <Row
                label="At Givebutter"
                hint={
                  givebutterMissing
                    ? "Never fetched — this total is short by whatever Givebutter is holding"
                    : `Collected and counted, not yet paid out${
                        summary.givebutterBalanceAsOf
                          ? ` · read ${stamp(summary.givebutterBalanceAsOf)}`
                          : ""
                      }`
                }
                value={
                  givebutterMissing
                    ? "—"
                    : formatCents(summary.givebutterUndepositedCents ?? 0)
                }
              />
            ) : null}
            <RelayBalanceEditor
              balanceCents={summary.relayBalanceCents}
              asOf={summary.relayBalanceAsOf}
              setByName={summary.relayBalanceSetByName}
            />
            {summary.relayFeedSyncedAt ? (
              <Text className="mt-1 text-2xs text-faint">
                Relay transactions last landed{" "}
                {stamp(summary.relayFeedSyncedAt)}. That feed refreshes when
                this page opens; the balance above does not — they age
                separately.
              </Text>
            ) : null}
          </View>
        ) : null}

        <View className="mt-1 border-t border-border pt-1">
          <Row
            label="Total we can point at"
            value={formatCents(summary.locatedCents)}
            strong
          />
        </View>
      </View>

      {!balanced ? (
        <View className="mt-3 gap-1">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Where to look
          </Text>
          {/* Ordered most-likely-first for the DIRECTION of this gap, so the
              first line is the one worth reading. Suppressed when there is no
              direction to reason from — with Stripe unread, "the books claim
              more than we can find" would be pointing at the wrong culprit. */}
          {/* In-flight gifts lead the list: the one explanation that is
              already fully known and fully self-resolving. A reader sent
              hunting through Reconcile for money the org itself receipted
              two days ago has been failed by this panel, not helped. */}
          {summary.inFlightGiftCount > 0 ? (
            <Text className="text-2xs text-muted">
              • {summary.inFlightGiftCount === 1 ? "A gift" : "Gifts"} totalling{" "}
              {formatCents(summary.inFlightGiftCents)}{" "}
              {summary.inFlightGiftCount === 1 ? "is" : "are"} still clearing
              the bank
              {summary.inFlightGifts.length > 0
                ? ` (${summary.inFlightGifts
                    .map(
                      (g) =>
                        `${g.donorName}, ${formatCents(g.amountCents)}, ${new Date(
                          g.submittedAt,
                        ).toLocaleDateString("en-US", {
                          timeZone: "America/New_York",
                          month: "short",
                          day: "numeric",
                        })}`,
                    )
                    .join("; ")})`
                : ""}
              . The donor already has the receipt email; Stripe holds it in
              pending while the transfer clears, and it books as a gift the
              moment it settles.
              {/* Two sources, printed together when both exist: our receipts
                  and Stripe's own bank_account-pending slice. Agreement is
                  corroboration a reader can check; silence about a second
                  source we hold would make this lead weaker than the data
                  behind it. */}
              {summary.stripePendingBankAccountCents != null &&
              summary.stripePendingBankAccountCents ===
                summary.inFlightGiftCents
                ? " Stripe's own balance confirms it — its bank-transfer pending slice matches to the cent."
                : ""}
              {summary.inFlightGiftCents === summary.differenceCents
                ? " That is this entire difference — nothing for you to do."
                : " Nothing for you to do on these."}
            </Text>
          ) : null}
          {/* The divergence case: Stripe says bank-transfer money is in
              transit and our receipts don't fully cover it. That remainder is
              an ACH moving through Stripe that the giving flow never saw —
              exactly the shape that deserves a name before it lands as a
              mystery credit. */}
          {summary.stripePendingBankAccountCents != null &&
          summary.stripePendingBankAccountCents >
            summary.inFlightGiftCents ? (
            <Text className="text-2xs text-warn">
              • Stripe reports{" "}
              {formatCents(summary.stripePendingBankAccountCents)} of
              bank-transfer money still clearing, but our gift receipts only
              account for {formatCents(summary.inFlightGiftCents)} of it. The
              remaining{" "}
              {formatCents(
                summary.stripePendingBankAccountCents -
                  summary.inFlightGiftCents,
              )}{" "}
              is an ACH moving through Stripe that the giving flow never saw —
              expect it to surface as a bank credit that needs recording when
              it lands.
            </Text>
          ) : null}
          {unknowable ? null : cashHigh ? (
            <Text className="text-2xs text-muted">
              • Income that never made it onto a book — a deposit sitting in
              Reconcile uncoded, or money collected somewhere the app
              doesn&apos;t sync. Start with the largest recent bank credit.
            </Text>
          ) : (
            <Text className="text-2xs text-muted">
              • The same money counted twice — a gift recorded AND the bank
              credit that delivered it. Tap a book in Account balances above;
              its breakdown scans for exactly this pair and offers to link them.
            </Text>
          )}
          {summary.unmatchedPayoutCount > 0 ? (
            <Text className="text-2xs text-muted">
              • {summary.unmatchedPayoutCount} payout
              {summary.unmatchedPayoutCount === 1 ? "" : "s"} worth{" "}
              {formatCents(summary.unmatchedPayoutCents)} whose bank deposit we
              never found. Until it&apos;s matched, that deposit counts as
              ordinary income on top of the revenue it was already paying for.
            </Text>
          ) : null}
          {/* The single most common explanation for a positive gap, so it
              leads with the strongest possible phrasing: when the lead's total
              EQUALS the gap, the mystery is solved and the panel should say
              so instead of presenting a number and a hint side by side. */}
          {summary.unrecordedInflowCount > 0 ? (
            <Text className="text-2xs text-muted">
              • {summary.unrecordedInflowCount} recent bank credit
              {summary.unrecordedInflowCount === 1 ? "" : "s"} worth{" "}
              {formatCents(summary.unrecordedInflowCents)} that look
              {summary.unrecordedInflowCount === 1 ? "s" : ""} like giving but
              {summary.unrecordedInflowCount === 1 ? " is" : " are"} recorded
              as nothing — an ACH or Zelle that landed without a gift entry.
              {summary.unrecordedInflowCents === summary.differenceCents
                ? " That is this entire difference."
                : ""}{" "}
              Confirm or dismiss them under Giving → possible gifts, and this
              number moves the moment you do.
            </Text>
          ) : null}
          {summary.inKindRevenueCents > 0 ? (
            <Text className="text-2xs text-muted">
              • {formatCents(summary.inKindRevenueCents)} of book value is
              in-kind gifts — goods and services, never cash. They&apos;re meant
              to be cancelled out by the expense they paid for, so they should
              not move this number. One entered without its expense will.
            </Text>
          ) : null}
          {summary.booksWithoutBankBalance.length > 0 ? (
            <Text className="text-2xs text-warn">
              • No bank balance has ever synced for{" "}
              {summary.booksWithoutBankBalance.join(", ")} — that account is
              missing from the money side entirely, which is not the same as it
              holding nothing.
            </Text>
          ) : null}
          {/* We can PROVE Relay exists — its transactions are syncing — and
              nobody has said what it holds. That is a real hole in the money
              side, and the only one the arithmetic deliberately can't flag for
              itself (an unrecorded balance is indistinguishable from no account
              at all), so it is named here instead. The collapsed card badges it
              too, because it is a defect in a total on display up there. */}
          {summary.relayBalanceCents == null &&
          summary.relayFeedSyncedAt != null ? (
            <Text className="text-2xs text-warn">
              • Relay&apos;s balance has never been recorded, and its
              transactions are still syncing — so the account is real and
              whatever is in it is missing from the money side. Record it above.
            </Text>
          ) : null}
          {summary.unattributedBankCents !== 0 ? (
            <Text className="text-2xs text-warn">
              • {formatCents(summary.unattributedBankCents)} sits in an Increase
              account no active book claims. It&apos;s counted above as real
              money, but nothing on the books is holding it.
            </Text>
          ) : null}
          {unknowable ? null : (
            <Text className="mt-1 text-2xs text-faint">
              Tap any book in Account balances above to open its breakdown — the
              duplicate scan and the &ldquo;counted as zero&rdquo; list are
              where a wrong number usually hides. &ldquo;See every line&rdquo;
              from there gives you the individual rows.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
