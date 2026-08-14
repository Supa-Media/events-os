/**
 * ONE MONTH'S PUBLISH FLOW — the whole of it, in one component, so there is
 * exactly one implementation of the act that talks to the whole city.
 *
 * This was the body of the publish console (`app/(app)/finances/publish.tsx`)
 * and it still is: the route renders it under its month list, and the
 * Transactions grid renders the SAME component in a modal over a month band
 * (`PublishMonthModal`). Founder, 2026-08-14: "I want to be able to preview
 * and publish from the same page — publish here takes me to a different page
 * entirely."
 *
 * ── WHY EXTRACT RATHER THAN GIVE THE BAND A PUBLISH BUTTON ───────────────────
 * Because the ceremony IS the act. The two-approver handoff and its
 * separation-of-duties check, the amendment reason a re-publish publishes with
 * it, the `SNAPSHOT_TRUNCATED` refusal that stops a partial month going out,
 * the disclosures a publisher has to read before the button is reachable —
 * none of that is paperwork in front of publishing; it is publishing. A
 * one-tap Publish on a band would have had to drop it or reimplement it, and a
 * reimplemented separation-of-duties check is how one gets quietly weakened.
 * So nothing was reimplemented and nothing was thinned: the same component
 * issues the same mutations against the same server gates, and only the frame
 * around it changes — the pattern `ReconcileList.tsx#openRecord` already uses
 * for a row's record (side panel when wide, modal otherwise).
 *
 * ── WHAT THE FRAME OWES ──────────────────────────────────────────────────────
 * Naming the book. Every call below carries the scope its host resolved, and a
 * publish that silently retargeted the caller's own chapter would be the worst
 * bug on this screen — it would publish one book's money under another book's
 * name. The route settles the book above its month list (`BookScopeNotice`);
 * the modal names it in its header. Neither may render this body without one.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  AMENDMENT_REASONS,
  AMENDMENT_REASON_LABELS,
  COMPENSATION_DISCLOSURE,
  formatCents,
  INCOME_STREAM_LABELS,
  MIN_AMENDMENT_NOTE_LENGTH,
  parsePeriodKey,
  type AmendmentReason,
} from "@events-os/shared";
import { Button, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { useLedgerPreview } from "../useLedgerPreview";
import { byMonthHref } from "../byMonthHref";

/** A real chapter's book, or central's — whatever `console_` answered about. */
export type PublishBookScope = NonNullable<
  ReturnType<typeof useQuery<typeof api.publicLedger.console_>>
>["scope"];

/** One month as the console reports it: status, what's live, what's in flight.
 *  Both frames read it from the same query, so neither can show a state the
 *  other cannot. */
export type PublishMonthSummary = NonNullable<
  ReturnType<typeof useQuery<typeof api.publicLedger.console_>>
>["months"][number];

/**
 * The month's notes-in-flight: a reviewer's send-back, and the sentence a
 * correction is being prepared under. Shown by both frames above the body,
 * because they are the reason the month is in the state it is in.
 */
export function PublishMonthNotes({ month }: { month: PublishMonthSummary }) {
  return (
    <>
      {month.reviewNote ? (
        <Text className="mt-2 text-sm text-danger">Sent back: {month.reviewNote}</Text>
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
    </>
  );
}

export function PublishMonthBody({
  month,
  scope,
  canPublish,
  onLeave,
}: {
  month: PublishMonthSummary;
  scope: PublishBookScope;
  canPublish: boolean;
  /**
   * The frame's way to get out of the way. Called immediately before this
   * body navigates somewhere else ("Explain them now"), so a modal host can
   * close itself first rather than leave a publish dialog floating over a
   * screen the reader was just sent to. The route has nothing to close and
   * passes nothing.
   */
  onLeave?: () => void;
}) {
  // EVERY call below carries the scope the host resolved. A preview or a
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
  const republish = useMutation(api.publicLedger.republish);
  // Mint-and-open lives in `useLedgerPreview` now — the Explain screen wants
  // the same button, and this was about to be its second copy.
  const previewPage = useLedgerPreview();

  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<AmendmentReason>("recategorized");

  /** Every action shares one runner so a refusal always reaches the screen.
   *  The backend's messages are written to be read by a human (see
   *  `publicLedger.ts`), so they're surfaced verbatim rather than replaced
   *  with a generic "something went wrong". THIS is how the server's refusals
   *  — a self-approval, an unexplained amendment, a truncated snapshot —
   *  reach a publisher, and it is identical in both frames because it is the
   *  same code. */
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
   * "Preview the page" — the FULL public render of this month, built from the
   * live books, in a new tab. Works in every working status (draft, in
   * review, sent back, mid-amendment): the mint only needs console access,
   * never a publishable snapshot, because looking is not the same commitment
   * publishing is. Mechanics (and why scope is omitted rather than sent as
   * `null`) live in `useLedgerPreview`; its own `loading` is deliberately
   * separate from `busy` so tapping it never looks like it queued behind a
   * submit/publish that's mid-flight.
   */
  const openPreviewPage = () =>
    previewPage.open({ scope, periodKey: month.periodKey });

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
                  warning becomes wallpaper.

                  POINTS AT THE GRID DIRECTLY, not through the `/finances/explain`
                  redirect that still stands in for old bookmarks. This is the
                  only path from the publish console to fixing these lines, and
                  routing the org's own live link through a compatibility shim is
                  how a shim becomes permanent. The three params are the same
                  three the redirect writes: the publishing population (no policy
                  date, so it reaches this month's reconstructed history),
                  biggest money first, banded by month.

                  `scope` is translated the same way the redirect translates it —
                  a chapter id is not one of the grid's three scope words and
                  would silently fall back to the caller's own desk, so it goes
                  to `chapterId`. */}
              <Button
                variant="secondary"
                size="sm"
                title="Explain them now"
                onPress={() => {
                  // The modal frame closes BEFORE the navigation; the route
                  // passes no `onLeave` and this is a no-op there.
                  onLeave?.();
                  router.push(
                    byMonthHref({
                      period: parsePeriodKey(month.periodKey),
                      scope: scope == null ? null : String(scope),
                    }) as never,
                  );
                }}
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
        loading={previewPage.loading}
        onPress={() => void openPreviewPage()}
      />

      {/* Two independent failure channels, rendered the same way: the action
          runner's (`error`) and the preview mint's. They can't both be set by
          one tap — the preview clears its own on each attempt and never
          touches `error`. */}
      {error ? <Text className="mt-3 text-sm text-danger">{error}</Text> : null}
      {previewPage.error ? (
        <Text className="mt-3 text-sm text-danger">{previewPage.error}</Text>
      ) : null}

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
            {/* THE BOOKS MOVED UNDER A PUBLISHED MONTH. A prompt, never an
                automatic amendment: republishing puts a new statement in front
                of the world and carries a human's sentence explaining it, so
                the app asks and the publisher decides (founder, 2026-08-14:
                "it should probably ask to republish the public ledgers and
                statements if they're already published"). The reason and note
                fields directly below are the ones to fill in — this call-out
                deliberately has no button of its own rather than duplicating
                them. Cleared automatically the next time the month
                publishes. */}
            {month.staleSince ? (
              <View className="flex-row items-start gap-2 rounded-lg border border-border bg-warn-bg p-3">
                <Icon name="alert-triangle" size={14} color={colors.warn} />
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink">
                    The books have changed since this was published
                  </Text>
                  <Text className="text-xs text-muted">
                    {month.staleReason ?? "Something changed in this month."} —
                    on {formatDate(month.staleSince)}. The public page still
                    shows revision {month.liveRevision ?? 1}. Correct and
                    republish below if the change should be public.
                  </Text>
                </View>
              </View>
            ) : null}
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
            {/* ONE ACTION, when the caller may do both halves (founder,
                2026-08-13: "the rows either need to not be frozen, or can be
                republished easily"). Same reason + sentence, same new
                revision, same public record — it just doesn't cost three
                screens to get a name off a live page.

                Offered only to a publisher: `republish` calls
                `resolveApprovalParty` with the caller as preparer AND
                publisher, which anyone but a superuser is refused for. Hiding
                it from the rest is what keeps the button from being a promise
                the server breaks; they get the reviewed flow below, which is
                the correct path for them. */}
            {canPublish ? (
              <Button
                title={`Correct and republish now (revision ${(month.liveRevision ?? 1) + 1})`}
                loading={busy}
                disabled={busy || noteTooShort}
                onPress={() =>
                  void act(() =>
                    republish({
                      scope,
                      periodKey: month.periodKey,
                      reason,
                      note: note.trim(),
                    } as never),
                  )
                }
              />
            ) : null}
            <Button
              variant="secondary"
              title={canPublish ? "Or hand it to someone to review" : "Start a correction"}
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
