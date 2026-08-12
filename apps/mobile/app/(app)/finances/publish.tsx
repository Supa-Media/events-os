/**
 * THE PUBLISH CONSOLE — where a month becomes public.
 *
 * The close already has a gate (`/finances` → the publishability card) that
 * says how far a period is from being publishable. This screen is the step
 * after it: prepare the month, hand it to a second person, and put it on
 * publicworship.life.
 *
 * ── THE SCREEN'S ONE JOB IS TO MAKE THE STAKES OBVIOUS ──────────────────────
 * Every other finance screen edits the org's own books, where a mistake is
 * caught at the next close. This one talks to the whole city, and a published
 * number cannot be un-seen — only amended in public. So the preview is not
 * optional decoration: the figures a publisher is about to stand behind, and
 * the disclosures that will publish beside them (rows with no receipt, rows
 * with no approved explanation, rows rebuilt from spreadsheets), are on
 * screen before the button is reachable.
 *
 * The disclosures are shown as FACTS, not as blockers. Publishing a month
 * with three undocumented rows AND saying there are three undocumented rows
 * is more honest than waiting a year for a perfect month — that judgement is
 * the publisher's to make, and this screen's job is to make sure they make it
 * knowingly rather than by omission. The backend refuses exactly one thing:
 * a snapshot that may be INCOMPLETE (`SNAPSHOT_TRUNCATED`), because that is
 * the failure a reader cannot detect for themselves.
 *
 * ── AMENDING ────────────────────────────────────────────────────────────────
 * A published month can only be corrected, never withdrawn. Starting an
 * amendment asks for the reason and the sentence that will publish with it,
 * up front — the person who noticed the problem is the person who can
 * describe it, and asking later means recording whatever the publisher could
 * reconstruct afterwards.
 *
 * Layout follows the house pattern (`book-value.tsx`): `FinanceBoundary` for
 * the permission wall, `Screen`/`Narrow` for the frame, no sentence composed
 * inline that a shared module already owns.
 */
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  AMENDMENT_REASONS,
  AMENDMENT_REASON_LABELS,
  COMPENSATION_DISCLOSURE,
  formatCents,
  INCOME_STREAM_LABELS,
  MIN_AMENDMENT_NOTE_LENGTH,
  PUBLICATION_STATUS_LABELS,
  type AmendmentReason,
  type PublicationStatus,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  Select,
  TextField,
  type BadgeTone,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { useChapterContext } from "../../../lib/ChapterContext";
// `publicSiteUrl` — the one canonical resolver for the public-page base URL
// (branded domain in prod, Convex .site fallback elsewhere). Lives with the
// Tickets tab's helpers, not because this is ticket-specific, but because
// that's where the org's first "open a preview link" button put it; finance
// code already reuses this module for `formatMoney`/`parseDollars`.
import { publicSiteUrl } from "../../../components/event/ticketing/helpers";

function NoAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Restricted"
      message="Only a finance seat can work the publish queue."
    />
  );
}

/** Status → chip tone. `published` is the only green: everything else is work
 *  in flight, and an amber "in review" that looked settled would invite
 *  someone to assume a month was already out. */
const STATUS_TONE: Record<PublicationStatus, BadgeTone> = {
  draft: "neutral",
  in_review: "warn",
  changes_requested: "danger",
  published: "success",
  amending: "warn",
};

export default function PublishScreen() {
  return (
    <FinanceBoundary fallback={<NoAccess />}>
      <Body />
    </FinanceBoundary>
  );
}

function Body() {
  const params = useLocalSearchParams<{ scope?: string }>();
  const { context } = useChapterContext();
  // WHICH BOOK ARE WE PUBLISHING? Resolved the same way every other finance
  // screen resolves it (`book-value.tsx`): `?scope=` wins so a shared link is
  // explicit, otherwise whichever desk the caller is standing at.
  //
  // This is NOT cosmetic. Passing nothing makes the backend fall back to the
  // caller's own chapter, which means CENTRAL'S BOOK CAN NEVER BE PUBLISHED —
  // and central is where the org's own money lives. It also means a central
  // holder peeking at a chapter would work their own queue while believing
  // they were working that chapter's.
  const scope =
    params.scope ??
    (context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat"
        ? context.scope
        : null);

  const data = useQuery(
    api.publicLedger.console_,
    scope ? ({ scope } as never) : {},
  );
  const [open, setOpen] = useState<string | null>(null);

  if (data === undefined) return <Screen loading />;
  if (data === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="book-open"
            title="No chapter yet"
            message="You'll be able to publish once you belong to a chapter."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title={`Publish — ${data.scopeName}`} />
        <Text className="mb-3 text-sm text-muted">
          Each month is closed, reviewed by someone who didn&apos;t prepare it, and
          then frozen. What goes out can&apos;t be edited afterwards — only
          corrected in public.
        </Text>
        {data.months.map((m) => (
          <MonthRow
            key={m.periodKey}
            month={m}
            scope={data.scope}
            canPublish={data.canPublish}
            expanded={open === m.periodKey}
            onToggle={() => setOpen(open === m.periodKey ? null : m.periodKey)}
          />
        ))}
      </Narrow>
    </Screen>
  );
}

/** A real chapter's book, or central's. */
type BookScope = NonNullable<
  ReturnType<typeof useQuery<typeof api.publicLedger.console_>>
>["scope"];

type MonthSummary = NonNullable<
  ReturnType<typeof useQuery<typeof api.publicLedger.console_>>
>["months"][number];

function MonthRow({
  month,
  scope,
  canPublish,
  expanded,
  onToggle,
}: {
  month: MonthSummary;
  scope: BookScope;
  canPublish: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-base font-semibold text-ink">{month.label}</Text>
        {month.liveRevision != null && month.liveRevision > 1 ? (
          <Text className="text-xs text-muted">rev {month.liveRevision}</Text>
        ) : null}
        <Badge
          tone={STATUS_TONE[month.status]}
          label={PUBLICATION_STATUS_LABELS[month.status]}
        />
        <Button
          variant="ghost"
          size="sm"
          title={expanded ? "Hide" : "Open"}
          onPress={onToggle}
        />
      </View>
      {month.reviewNote ? (
        <Text className="mt-2 text-sm text-danger">
          Sent back: {month.reviewNote}
        </Text>
      ) : null}
      {month.status === "amending" && month.amendmentNote ? (
        <Text className="mt-2 text-sm text-muted">
          Correcting:{" "}
          {month.amendmentReason
            ? `${AMENDMENT_REASON_LABELS[month.amendmentReason]} — `
            : ""}
          {month.amendmentNote}
        </Text>
      ) : null}
      {expanded ? (
        <MonthDetail month={month} scope={scope} canPublish={canPublish} />
      ) : null}
    </Card>
  );
}

function MonthDetail({
  month,
  scope,
  canPublish,
}: {
  month: MonthSummary;
  scope: BookScope;
  canPublish: boolean;
}) {
  // EVERY call below carries the scope the console resolved. A preview or a
  // publish that silently retargeted the caller's own chapter would be the
  // worst possible bug on this screen: it would publish one book's money under
  // another book's name.
  const preview = useQuery(api.publicLedger.preview, {
    scope,
    periodKey: month.periodKey,
  } as never);
  const submit = useMutation(api.publicLedger.submit);
  const publish = useMutation(api.publicLedger.publish);
  const requestChanges = useMutation(api.publicLedger.requestChanges);
  const startAmendment = useMutation(api.publicLedger.startAmendment);
  const mintPreviewToken = useMutation(api.publicLedger.mintLedgerPreviewToken);

  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<AmendmentReason>("recategorized");
  const [previewPageLoading, setPreviewPageLoading] = useState(false);

  /** Every action shares one runner so a refusal always reaches the screen.
   *  The backend's messages are written to be read by a human (see
   *  `publicLedger.ts`), so they're surfaced verbatim rather than replaced
   *  with a generic "something went wrong". */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote("");
    } catch (e) {
      const data = (e as { data?: { message?: string } })?.data;
      setError(data?.message ?? "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Preview the page" — mint a short-lived token and open the FULL public
   * render of this month, built from the live books, in a new tab. Works in
   * every working status (draft, in review, sent back, mid-amendment): the
   * mint only needs console access, never a publishable snapshot, because
   * looking is not the same commitment publishing is.
   *
   * Mirrors `TicketingTab.tsx#openPreview`'s RSVP draft-preview pattern —
   * mint, then `Linking.openURL` — with its own loading flag rather than
   * `busy` so tapping it never looks like it queued behind a submit/publish
   * that's mid-flight.
   */
  const openPreviewPage = async () => {
    setPreviewPageLoading(true);
    setError(null);
    try {
      const { token } = await mintPreviewToken({
        scope,
        periodKey: month.periodKey,
      } as never);
      void Linking.openURL(
        `${publicSiteUrl()}/finances/${month.periodKey}?preview=${token}`,
      );
    } catch (e) {
      const data = (e as { data?: { message?: string } })?.data;
      setError(data?.message ?? "Couldn't open the preview. Try again.");
    } finally {
      setPreviewPageLoading(false);
    }
  };

  const noteTooShort = note.trim().length < MIN_AMENDMENT_NOTE_LENGTH;

  return (
    <View className="mt-3 border-t border-border pt-3">
      {preview === undefined ? (
        <Text className="text-sm text-muted">Building the preview…</Text>
      ) : preview === null ? (
        <Text className="text-sm text-muted">Nothing to preview.</Text>
      ) : (
        <>
          <Figures
            label="Money in"
            cents={preview.incomeCents}
            detail={preview.incomeByStream
              .map((s) => `${INCOME_STREAM_LABELS[s.stream]} ${formatCents(s.cents)}`)
              .join(" · ")}
          />
          <Figures label="Money out" cents={preview.expenseCents} />
          <Figures label="Difference" cents={preview.netCents} />
          <Text className="mt-2 text-xs text-muted">
            {preview.entryCount} line{preview.entryCount === 1 ? "" : "s"} ·{" "}
            {preview.giftCount} gift{preview.giftCount === 1 ? "" : "s"}
          </Text>

          {/* The disclosures that will publish beside the numbers. Shown
              before the button, never after — a publisher should not learn
              what they disclosed by reading the public page. */}
          {preview.undocumentedCount > 0 ? (
            <Disclosure
              text={`${preview.undocumentedCount} lines (${formatCents(preview.undocumentedCents)}) will publish with no receipt and no approved exception.`}
            />
          ) : null}
          {/* What a READER will see. On a pre-policy month (2024/2025) the
              policy gap below is zero while every line is unexplained, so
              showing only the policy number would tell a publisher their
              historical month was clean when it is about to publish a page of
              blanks. */}
          {preview.unexplainedCount > 0 ? (
            <>
              <Disclosure
                text={`${preview.unexplainedCount} lines (${formatCents(preview.unexplainedCents)}) will publish with no written explanation of what they were for.`}
              />
              {/* The disclosure and the fix, one tap apart. Reading "61 lines
                  will publish blank" and having nowhere to go from it is how a
                  warning becomes wallpaper. */}
              <Button
                variant="secondary"
                size="sm"
                title="Explain them now"
                onPress={() =>
                  router.push(
                    `/finances/explain?period=${month.periodKey}&scope=${scope}` as never,
                  )
                }
              />
            </>
          ) : null}
          {preview.uncodedCount > 0 ? (
            <Disclosure
              text={`${preview.uncodedCount} of those are charges the coding policy covers — they owe an explanation and don't have an approved one.`}
            />
          ) : null}
          {preview.reconstructedCount > 0 ? (
            <Disclosure
              text={`${preview.reconstructedCount} lines (${formatCents(preview.reconstructedCents)}) were rebuilt from records rather than captured live, and will say so.`}
            />
          ) : null}
          {/* The compensation claim is the one disclosure the ledger cannot
              check for itself — there is no notion of payroll in the schema,
              so it is a stated fact with a human behind it. Showing it back
              here every month is what keeps "nobody is paid" from quietly
              becoming false on a public page. */}
          {COMPENSATION_DISCLOSURE.allVolunteer ? (
            <Text className="mt-2 text-sm text-muted">
              This month will publish “{COMPENSATION_DISCLOSURE.headline}” — is
              that still true? If anyone is now paid, that line has to change
              before you publish.
            </Text>
          ) : null}
          {preview.truncated || preview.overCap ? (
            <Text className="mt-2 text-sm font-semibold text-danger">
              This month is too large to snapshot safely, so it can&apos;t be
              published. An incomplete ledger presented as complete is worse than
              a late one.
            </Text>
          ) : null}
        </>
      )}

      {/* Full page, not just the figures above — works in EVERY working
          status, because "see what this would look like" is a weaker ask
          than "publish it" and shouldn't wait for the same readiness. */}
      <Button
        title="Preview the page"
        icon="eye"
        variant="secondary"
        size="sm"
        loading={previewPageLoading}
        onPress={() => void openPreviewPage()}
      />

      {error ? <Text className="mt-3 text-sm text-danger">{error}</Text> : null}

      <View className="mt-3 gap-2">
        {(month.status === "draft" ||
          month.status === "changes_requested" ||
          month.status === "amending") && (
          <Button
            title="Send for review"
            loading={busy}
            onPress={() => void act(() => submit({ scope, periodKey: month.periodKey } as never))}
          />
        )}

        {month.status === "in_review" && canPublish && (
          <>
            <Button
              title={
                month.liveRevision != null
                  ? `Publish correction (revision ${month.liveRevision + 1})`
                  : "Publish to the public page"
              }
              loading={busy}
              onPress={() => void act(() => publish({ scope, periodKey: month.periodKey } as never))}
            />
            <TextField
              label="Or send it back"
              placeholder="What would make this publishable?"
              value={note}
              onChangeText={setNote}
              multiline
            />
            <Button
              variant="secondary"
              title="Send back"
              disabled={busy || noteTooShort}
              onPress={() =>
                void act(() =>
                  requestChanges({ scope, periodKey: month.periodKey, note: note.trim() } as never),
                )
              }
            />
          </>
        )}

        {month.status === "in_review" && !canPublish && (
          <Text className="text-sm text-muted">
            Waiting on someone with the Publish finances power. You can&apos;t
            approve a month you prepared.
          </Text>
        )}

        {month.status === "published" && (
          <>
            <Text className="text-sm text-muted">
              Published. It can be corrected, but not taken down — the earlier
              version stays on the record either way.
            </Text>
            <Select
              label="What are you correcting?"
              value={reason}
              onChange={(v) => setReason(v as AmendmentReason)}
              options={AMENDMENT_REASONS.map((r) => ({
                label: AMENDMENT_REASON_LABELS[r],
                value: r,
              }))}
            />
            <TextField
              label="What changed, and why"
              placeholder="This sentence publishes with the correction."
              value={note}
              onChangeText={setNote}
              multiline
            />
            <Button
              variant="secondary"
              title="Start a correction"
              disabled={busy || noteTooShort}
              onPress={() =>
                void act(() =>
                  startAmendment({
                    scope,
                    periodKey: month.periodKey,
                    reason,
                    note: note.trim(),
                  } as never),
                )
              }
            />
          </>
        )}
      </View>
    </View>
  );
}

function Figures({
  label,
  cents,
  detail,
}: {
  label: string;
  cents: number;
  detail?: string;
}) {
  return (
    <View className="py-1">
      <View className="flex-row items-baseline gap-3">
        <Text className="flex-1 text-sm text-muted">{label}</Text>
        <Text
          className="text-sm font-semibold text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(cents)}
        </Text>
      </View>
      {detail ? <Text className="text-xs text-muted">{detail}</Text> : null}
    </View>
  );
}

function Disclosure({ text }: { text: string }) {
  return <Text className="mt-2 text-sm text-warn">{text}</Text>;
}
