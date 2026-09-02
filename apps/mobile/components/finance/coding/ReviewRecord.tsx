/**
 * THE RECORD BEHIND ONE REVIEW ROW — the whole thing, in place.
 *
 * Founder, 2026-08-24, on the Coding tab's review queue: "when reviewing it
 * doesn't let me review all the fields they entered, like if it's a meal, I
 * should see people's names listed for the meal, I should also be able to
 * review receipts or receipt exception requests."
 *
 * `ReviewQueue`'s row is a SUMMARY — the purpose plus one substantiation line
 * (`queueDisplay.ts#substantiationLine`). That is enough to clear an obvious
 * row and not enough to actually review one: the attendee list, the travelers,
 * the category and budget the money lands in, the send-back conversation so
 * far, the receipt itself, and the exception request standing in for a missing
 * receipt all lived on other surfaces. This is the expansion of that row, fed
 * by ONE query (`transactionCodings.reviewRecord`) gated by the coding VIEW
 * resolver — so it works for every reviewer the queue hands a row to, not just
 * the ones who happen to hold bookkeeper rank in the row's own book.
 *
 * Order is the reviewer's own order, and it is deliberate:
 *   1. THE PROOF — the receipt, big, or the exception request that stands in
 *      for it. You read the document before you read the claim about it.
 *   2. WHAT THEY ENTERED — every §274(d) field, named, including the attendee
 *      list with each person's affiliation. Nothing is summarized away here;
 *      the summary is what the row already showed.
 *   3. THE CHARGE — merchant, the raw bank line under it, book, cardholder,
 *      category, budget. The raw line is the only thing that can contradict a
 *      tidy merchant name.
 *   4. THE TRAIL — who coded it and when, the last send-back note, the
 *      decision if one has landed.
 *
 * DECIDING is deliberately NOT here: Approve / Send back stay on the queue row
 * itself (`ReviewQueue`), where they have always been, so opening the record
 * and deciding are one continuous motion down the same column rather than two
 * button sets in two places arguing about which is real.
 *
 * ── CORRECTING IS HERE, THOUGH (2026-09-02) ──────────────────────────────────
 * Founder, on this exact screen, looking at a merch invoice reading "Not
 * attributed to a budget": *"got to make sure the treasurer/financial manager
 * can edit details like the budget category for example, we shouldn't be
 * letting things go through without a budget, also allow them to edit any
 * other details they want instead of sending back and forth."*
 *
 * Every fact in blocks 2 and 3 was read-only, so a reviewer who could SEE that
 * the budget was missing had one way to fix it: send the whole coding back to
 * the cardholder over a field the coding form itself tells the cardholder to
 * leave blank. `ReviseUnderReview` (see its own doc) is the other way — the
 * same field set the author fills, in review mode, writing through
 * `transactionCodings.reviseUnderReview`. Two things it deliberately does not
 * touch: the author's `businessPurpose` (their testimony; the reviewer's
 * channel for the PUBLISHED wording is "Edit what publishes" on the row), and
 * authorship itself — a reviewer who fixes a route does not become the author,
 * which is both honest and what keeps their own later approval legal under
 * separation of duties.
 *
 * The other decision this surface owns is the receipt EXCEPTION — approve or
 * reject the request to document a charge without a receipt. It is a different
 * power with a different reach (`requireApproveReceiptException`: Finance
 * manager, in the row's OWN book — a central reviewer of a chapter's coding
 * does not necessarily hold it), so the server answers `canDecideException`
 * and a caller without it gets the request in full, read-only, with the reason
 * — the same `canReview: false` posture the queue row itself takes.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  ATTENDEE_AFFILIATION_LABELS,
  formatCents,
} from "@events-os/shared";
import {
  Badge,
  Button,
  FileThumbnail,
  FileViewer,
  FileViewerFrame,
  Icon,
  TextField,
  type BadgeTone,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { ReviseUnderReview } from "./ReviseUnderReview";
import type { RunAction } from "./ReviewQueue";

const EXCEPTION_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warn",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
};

/** Every date on this surface, in the finance timezone — a receipt dated the
 *  day either side of the charge is a thing a reviewer notices, so the two
 *  must be rendered by the same clock. */
function when(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/** One labelled fact. The label is always rendered, even when the value is
 *  missing — "Budget: not attributed" is a finding; a row that silently omits
 *  the line reads as a record with nothing to say about it. */
function Fact({
  label,
  value,
  missing = "—",
}: {
  label: string;
  value: string | null | undefined;
  missing?: string;
}) {
  return (
    <View className="min-w-[150px] flex-1 basis-[46%]">
      <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
      <Text className={value ? "text-xs text-ink" : "text-xs italic text-muted"}>
        {value || missing}
      </Text>
    </View>
  );
}

function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </Text>
      {hint ? <Text className="text-2xs text-muted">{hint}</Text> : null}
      {children}
    </View>
  );
}

/**
 * THE RECEIPT, BIG — the same zoom/pan/page frame `ReceiptPane` and
 * `ReceiptViewerModal` mount (`ui/FileViewer.tsx`), with a pager when a
 * charge carries more than one file.
 *
 * The receipt's OWN extracted amount and date ride along in the caption
 * rather than being left in the record below: "does the document say what the
 * charge says" is the first question a reviewer asks, and making them hold two
 * numbers in their head across a scroll is how it stops getting asked.
 */
function ReceiptViewer({
  receipts,
  chargeAmountCents,
}: {
  receipts: {
    url: string | null;
    contentType: string | null;
    filename: string | null;
    amountCents: number | null;
    receiptDate: number | null;
    merchant: string | null;
  }[];
  chargeAmountCents: number;
}) {
  const [index, setIndex] = useState(0);
  const file = receipts[Math.min(index, receipts.length - 1)];
  if (!file?.url) {
    return (
      <View className="h-[360px] items-center justify-center gap-2 rounded-xl border border-border bg-sunken px-8">
        <Icon name="alert-triangle" size={24} color={colors.faint} />
        <Text className="text-center text-sm font-semibold text-ink">
          The record says a receipt is attached, but the file couldn&apos;t be
          loaded.
        </Text>
      </View>
    );
  }
  // Only flagged when the receipt actually carries an extracted amount —
  // absent extraction is not a mismatch, and rendering it as one would train
  // reviewers to ignore the flag that matters.
  const mismatch =
    file.amountCents != null &&
    Math.abs(file.amountCents) !== Math.abs(chargeAmountCents);

  return (
    <View className="gap-1.5">
      <View
        className="w-full overflow-hidden rounded-xl border border-border"
        style={{ height: 420, backgroundColor: "rgba(20, 6, 6, 0.985)" }}
      >
        <FileViewerFrame
          uri={file.url}
          contentType={file.contentType}
          filename={file.filename}
          caption={
            receipts.length > 1
              ? `${file.filename ?? "Receipt"} (${index + 1} of ${receipts.length})`
              : (file.filename ?? undefined)
          }
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        {file.amountCents != null ? (
          <View className="flex-row items-center gap-1.5">
            <Icon
              name={mismatch ? "alert-triangle" : "check"}
              size={11}
              color={mismatch ? colors.warn : colors.success}
            />
            <Text className="text-2xs text-muted">
              Receipt reads {formatCents(Math.abs(file.amountCents))}
              {mismatch
                ? ` — the charge is ${formatCents(Math.abs(chargeAmountCents))}`
                : " — matches the charge"}
            </Text>
          </View>
        ) : null}
        {file.receiptDate != null ? (
          <Text className="text-2xs text-muted">
            Dated {when(file.receiptDate)}
          </Text>
        ) : null}
        {file.merchant ? (
          <Text className="text-2xs text-muted">From {file.merchant}</Text>
        ) : null}
      </View>
      {receipts.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {receipts.map((r, i) => (
            <Pressable
              key={`${r.url ?? "missing"}-${i}`}
              onPress={() => setIndex(i)}
              accessibilityRole="imagebutton"
              accessibilityLabel={`Receipt ${i + 1} of ${receipts.length}`}
              className="active:opacity-70"
            >
              <View
                className={`h-14 w-14 overflow-hidden rounded-md border bg-sunken ${
                  i === index ? "border-accent" : "border-border"
                }`}
              >
                {r.url ? (
                  <FileThumbnail uri={r.url} contentType={r.contentType} />
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * ONE receipt-exception request, in full — the reason, the filer's words, what
 * they attested they tried, the evidence photos, and the decision if one has
 * landed.
 *
 * A PENDING one carries Approve / Reject for a caller who holds the power
 * (`canDecide`, from the server's own `hasApproveReceiptException`). Rejection
 * requires a note, exactly as `receiptExceptions.reject` requires one: the
 * filer has to be told what would make it approvable.
 *
 * Read-only for everyone else, WITH the reason — a reviewer who can approve
 * the coding but not the exception is a real and common shape (a central FM on
 * a chapter's charge), and an unexplained missing button reads as a bug.
 */
function ExceptionRequest({
  row,
  canDecide,
  runAction,
  onView,
}: {
  row: {
    _id: Id<"receiptExceptions">;
    reasonLabel: string;
    statusLabel: string;
    status: string;
    note: string;
    amountCents: number;
    attestations: { key: string; prompt: string; answer: boolean }[];
    evidence: { url: string; contentType: string | null }[];
    attestedByName: string | null;
    attestedAt: number;
    decidedByName: string | null;
    decidedAt: number | null;
    decisionNote: string | null;
  };
  canDecide: boolean;
  runAction: RunAction;
  onView: (file: { url: string; contentType: string | null }) => void;
}) {
  const approve = useMutation(api.receiptExceptions.approve);
  const reject = useMutation(api.receiptExceptions.reject);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await runAction(fn, { errorTitle: "Couldn't record that decision" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="rounded-lg border border-border bg-sunken px-3 py-2.5">
      <View className="mb-1 flex-row flex-wrap items-center gap-2">
        <Badge
          label={row.statusLabel}
          tone={EXCEPTION_STATUS_TONE[row.status] ?? "neutral"}
        />
        <Text className="text-xs font-medium text-ink">{row.reasonLabel}</Text>
        <Text className="text-2xs text-muted">
          {formatCents(Math.abs(row.amountCents))}
        </Text>
      </View>
      <Text className="text-xs text-ink">{row.note}</Text>
      <Text className="mt-1 text-2xs text-muted">
        Attested by {row.attestedByName ?? "someone no longer on the roster"} ·{" "}
        {when(row.attestedAt)}
        {row.decidedAt != null
          ? ` · decided by ${row.decidedByName ?? "—"} · ${when(row.decidedAt)}`
          : ""}
      </Text>
      {row.decisionNote ? (
        <Text className="mt-1 text-2xs italic text-muted">
          “{row.decisionNote}”
        </Text>
      ) : null}

      {/* Worded as ATTESTED everywhere, deliberately: nobody verified any of
          it — a person can answer yes and be wrong — and copy implying
          otherwise would turn a useful record into a false one. */}
      {row.attestations.length > 0 ? (
        <View className="mt-2 rounded-md border border-border px-2.5 py-2">
          <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
            Attested by the filer — not verified
          </Text>
          {row.attestations.map((a) => (
            <View key={a.key} className="flex-row items-start gap-1.5">
              <Icon
                name={a.answer ? "check" : "x"}
                size={11}
                color={a.answer ? colors.success : colors.muted}
              />
              <Text className="flex-1 text-2xs text-muted">
                {a.prompt}{" "}
                <Text className="font-semibold text-ink">
                  {a.answer ? "Yes" : "No"}
                </Text>
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {row.evidence.length > 0 ? (
        <View className="mt-2">
          <View className="mb-1 flex-row items-center gap-1.5">
            <Icon name="paperclip" size={11} color={colors.muted} />
            <Text className="text-2xs text-muted">
              Proof of purchase ({row.evidence.length}) — evidence, not a
              receipt
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {row.evidence.map((file, i) => (
              <Pressable
                key={file.url}
                onPress={() => onView(file)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Evidence ${i + 1}`}
                className="active:opacity-70"
              >
                <View className="h-16 w-16 overflow-hidden rounded-md border border-border">
                  <FileThumbnail uri={file.url} contentType={file.contentType} />
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {row.status === "pending" ? (
        canDecide ? (
          <View className="mt-2.5 gap-2">
            {rejecting ? (
              <>
                <TextField
                  label="Why not?"
                  value={note}
                  onChangeText={setNote}
                  placeholder="The filer needs to know what would make it approvable."
                  multiline
                  numberOfLines={2}
                />
                <View className="flex-row gap-2">
                  <Button
                    title="Confirm rejection"
                    size="sm"
                    loading={busy}
                    disabled={!note.trim()}
                    onPress={() =>
                      void run(async () => {
                        await reject({
                          exceptionId: row._id,
                          decisionNote: note.trim(),
                        });
                        setRejecting(false);
                      })
                    }
                  />
                  <Button
                    title="Cancel"
                    size="sm"
                    variant="secondary"
                    onPress={() => setRejecting(false)}
                  />
                </View>
              </>
            ) : (
              <View className="flex-row gap-2">
                <Button
                  title="Approve exception"
                  size="sm"
                  loading={busy}
                  onPress={() =>
                    void run(() => approve({ exceptionId: row._id }))
                  }
                />
                <Button
                  title="Reject"
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setRejecting(true);
                    setNote("");
                  }}
                />
              </View>
            )}
          </View>
        ) : (
          <Text className="mt-2 text-2xs italic text-muted">
            Deciding this exception needs the Finance manager role in this
            charge&apos;s own book — you can still approve or send back the
            coding.
          </Text>
        )
      ) : null}
    </View>
  );
}

/** The attendee list, named. This is the §274(d) business-relationship
 *  element and the founder's specific ask — a meal's people, listed, with how
 *  each relates to the org. Names are internal forever; the public ledger
 *  prints the affiliation breakdown instead, which is what the row's own
 *  summary line already showed. */
function AttendeeList({
  people,
  emptyLabel,
}: {
  people: { name: string; affiliation: string }[];
  emptyLabel: string;
}) {
  if (people.length === 0) {
    return <Text className="text-xs italic text-muted">{emptyLabel}</Text>;
  }
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {people.map((p, i) => (
        <View
          key={`${p.name}-${i}`}
          className="flex-row items-center gap-1.5 rounded-full border border-border bg-sunken px-2.5 py-1"
        >
          <Text className="text-xs text-ink">{p.name}</Text>
          <Text className="text-2xs text-muted">
            {ATTENDEE_AFFILIATION_LABELS[
              p.affiliation as keyof typeof ATTENDEE_AFFILIATION_LABELS
            ] ?? p.affiliation}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ReviewRecord({
  transactionId,
  runAction,
}: {
  transactionId: string;
  runAction: RunAction;
}) {
  const record = useQuery(api.transactionCodings.reviewRecord, {
    transactionId: transactionId as Id<"transactions">,
  });
  const [viewing, setViewing] = useState<{
    url: string;
    contentType: string | null;
  } | null>(null);
  // ONE panel, opened deliberately. Not always-open: this is a queue somebody
  // scans down, and most rows need reading, not editing — a form unfolded on
  // every row would bury the receipt that is the actual job. The exception is
  // the row that CANNOT be approved as it stands (`budgetRequired`), which
  // opens the panel for them, because on that row the edit IS the job.
  //
  // `null` means "however the row itself says", which is what makes Cancel
  // work on a budget-required row: a plain boolean defaulting to the flag
  // would leave the panel open after Cancel and read as a dead button.
  const [revising, setRevising] = useState<boolean | null>(null);

  if (record === undefined) {
    return (
      <View className="border-t border-border bg-sunken px-4 py-6">
        <Text className="text-xs text-muted">Opening the record…</Text>
      </View>
    );
  }

  const { charge, coding, receipts, exceptions, namesRedacted } = record;
  const canRevise = record.canRevise;
  const showRevise = canRevise && (revising ?? charge.budgetRequired);
  const pendingException =
    exceptions.find((e) => e.status === "pending") ?? null;
  const approvedException =
    exceptions.find((e) => e.status === "approved") ?? null;
  // The one exception the proof slot above renders in full — nothing else, so
  // a charge with an approved exception AND a rejected one doesn't print the
  // approved one twice. When a receipt is attached it wins the slot outright
  // and EVERY exception falls to the list below, pending ones included: a
  // request left open behind a late-attached receipt is exactly the thing a
  // reviewer should still be able to see and decide.
  const shownAsProof =
    receipts.length > 0 ? null : (pendingException ?? approvedException);
  const otherExceptions = exceptions.filter(
    (e) => e._id !== shownAsProof?._id,
  );
  const isMeal = coding?.headcount != null;
  const travelers = coding?.travelers ?? [];

  return (
    <View className="gap-5 border-t border-border bg-sunken px-4 py-4">
      {/* ── 1. THE PROOF ──────────────────────────────────────────────── */}
      <Block
        title="The proof"
        hint={
          receipts.length > 0
            ? "Read the document before the claim about it. Pinch or use the zoom controls to check a line."
            : undefined
        }
      >
        {receipts.length > 0 ? (
          <ReceiptViewer
            receipts={receipts}
            chargeAmountCents={charge.amountCents}
          />
        ) : pendingException ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-1.5">
              <Icon name="clock" size={12} color={colors.warn} />
              <Text className="text-xs text-ink">
                No receipt. There is an exception request waiting on a decision
                — decide it before you decide the coding.
              </Text>
            </View>
            <ExceptionRequest
              row={pendingException}
              canDecide={record.canDecideException}
              runAction={runAction}
              onView={setViewing}
            />
          </View>
        ) : approvedException ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-1.5">
              <Icon name="edit-3" size={12} color={colors.success} />
              <Text className="text-xs text-ink">
                No receipt — documented by an approved exception.
              </Text>
            </View>
            <ExceptionRequest
              row={approvedException}
              canDecide={record.canDecideException}
              runAction={runAction}
              onView={setViewing}
            />
          </View>
        ) : (
          // Unreachable on a SUBMITTED coding — the documentation gate refuses
          // one. Rendered loudly rather than quietly, because if it appears it
          // means a rule stopped holding.
          <View className="flex-row items-start gap-1.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
            <Icon name="alert-triangle" size={13} color={colors.danger} />
            <Text className="flex-1 text-xs text-ink">
              Nothing documents this charge — no receipt and no exception. A
              coding shouldn&apos;t have been submittable without one; send it
              back rather than approving it.
            </Text>
          </View>
        )}

        {/* Every OTHER exception on the charge, rejections and withdrawals
            included: "what was claimed, and who decided" is the audit story a
            published ledger has to be able to answer, and a UI that renders
            only the winning row can't tell it. `canDecide` is passed honestly
            rather than hard-coded false — a pending request that landed here
            (because a receipt was attached after it was filed) is still open,
            and still somebody's to decide. */}
        {otherExceptions.length > 0 ? (
          <View className="mt-1 gap-2">
            <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
              {otherExceptions.some((e) => e.status === "pending")
                ? "Other exceptions on this charge"
                : "Exception history"}
            </Text>
            {otherExceptions.map((e) => (
              <ExceptionRequest
                key={e._id}
                row={e}
                canDecide={record.canDecideException}
                runAction={runAction}
                onView={setViewing}
              />
            ))}
          </View>
        ) : null}
      </Block>

      {/* ── 2. WHAT THEY ENTERED ──────────────────────────────────────── */}
      {coding ? (
        <Block title="What they entered">
          <View className="gap-3 rounded-lg border border-border bg-raised px-3 py-3">
            <View>
              <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                Business purpose · {coding.expenseTypeLabel}
              </Text>
              <Text className="text-sm text-ink">{coding.businessPurpose}</Text>
            </View>

            {coding.publicPurpose ? (
              <View>
                <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                  What publishes instead
                </Text>
                <Text className="text-xs text-ink">{coding.publicPurpose}</Text>
                <Text className="text-2xs text-muted">
                  Rewritten by {coding.publicPurposeByName ?? "a reviewer"}
                  {coding.publicPurposeAt != null
                    ? ` · ${when(coding.publicPurposeAt)}`
                    : ""}
                </Text>
              </View>
            ) : null}

            {coding.travelFrom || coding.travelTo ? (
              <View className="flex-row flex-wrap gap-x-6 gap-y-2">
                <Fact
                  label={
                    coding.expenseType === "lodging" ? "Stayed in" : "Travelled from"
                  }
                  value={
                    coding.expenseType === "lodging"
                      ? coding.travelTo
                      : coding.travelFrom
                  }
                  missing="Not answered"
                />
                {coding.expenseType !== "lodging" ? (
                  <Fact label="To" value={coding.travelTo} missing="Not answered" />
                ) : null}
              </View>
            ) : null}

            {travelers.length > 0 ? (
              <View className="gap-1">
                <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                  Who travelled
                </Text>
                <AttendeeList people={travelers} emptyLabel="Nobody named" />
              </View>
            ) : null}

            {isMeal ? (
              <View className="gap-1">
                <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                  Who was there — {coding.headcount}{" "}
                  {coding.headcount === 1 ? "person" : "people"}
                </Text>
                {coding.attendees && coding.attendees.length > 0 ? (
                  <AttendeeList
                    people={coding.attendees}
                    emptyLabel="Nobody named"
                  />
                ) : coding.groupDescription ? (
                  <Text className="text-xs text-ink">
                    {coding.groupDescription}
                  </Text>
                ) : namesRedacted ? (
                  <Text className="text-xs italic text-muted">
                    Names are not shown to you on this row.
                  </Text>
                ) : (
                  <Text className="text-xs italic text-muted">
                    Nobody was named — a headcount alone doesn&apos;t say who
                    the org was hosting. Send it back if the group isn&apos;t
                    described.
                  </Text>
                )}
                {Object.keys(coding.affiliationBreakdown).length > 0 ? (
                  <Text className="text-2xs text-muted">
                    Publishes as{" "}
                    {Object.entries(coding.affiliationBreakdown)
                      .map(([affiliation, count]) => {
                        const label =
                          ATTENDEE_AFFILIATION_LABELS[
                            affiliation as keyof typeof ATTENDEE_AFFILIATION_LABELS
                          ] ?? affiliation;
                        return `${count} ${label.toLowerCase()}${count === 1 ? "" : "s"}`;
                      })
                      .join(", ")}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </Block>
      ) : null}

      {/* ── 3. THE CHARGE ─────────────────────────────────────────────── */}
      <Block title="The charge">
        {/* THE CORRECTION PASS. Sits between the facts and the trail on
            purpose: it is the answer to whatever the facts below just showed
            was wrong, and putting it under the trail would mean scrolling
            past the decision history to fix a budget. */}
        {showRevise ? (
          <ReviseUnderReview
            transactionId={transactionId}
            coding={
              coding ?? {
                // Unreachable while a coding exists, which `canRevise`
                // already requires — spelled out rather than force-unwrapped
                // so a future change to that flag fails visibly.
                expenseType: "general",
                businessPurpose: "",
                travelFrom: null,
                travelTo: null,
                headcount: null,
                attendees: null,
                groupDescription: null,
              }
            }
            categoryId={charge.categoryId}
            budgetId={charge.budgetId}
            budgetRequired={charge.budgetRequired}
            runAction={runAction}
            onDone={() => setRevising(false)}
          />
        ) : canRevise ? (
          <View className="flex-row">
            <Button
              title="Correct these details"
              size="sm"
              variant="secondary"
              icon="edit-3"
              onPress={() => setRevising(true)}
            />
          </View>
        ) : null}
        <View className="flex-row flex-wrap gap-x-6 gap-y-2.5">
          <Fact label="Merchant" value={charge.merchantName} />
          <Fact
            label="On the statement"
            value={charge.rawBankLine}
            missing="Same as the merchant name"
          />
          <Fact label="Amount" value={formatCents(Math.abs(charge.amountCents))} />
          <Fact label="Posted" value={when(charge.postedAt)} />
          <Fact label="Book" value={charge.bookName} />
          <Fact
            label="Cardholder"
            value={charge.cardholderName}
            missing="Nobody attributed"
          />
          <Fact
            label="Category"
            value={charge.categoryName}
            missing="Uncategorized"
          />
          <Fact
            label="Budget"
            value={charge.budgetName}
            missing={
              charge.budgetRequired
                ? "None — this can't be approved until one is set"
                : "Not attributed to a budget"
            }
          />
        </View>
      </Block>

      {/* ── 4. THE TRAIL ──────────────────────────────────────────────── */}
      {coding ? (
        <Block title="The trail">
          <View className="flex-row flex-wrap gap-x-6 gap-y-2.5">
            <Fact
              label="Coded by"
              value={coding.codedByName}
              missing="Someone no longer on the roster"
            />
            <Fact label="Submitted" value={when(coding.submittedAt)} />
            <Fact label="Status" value={coding.statusLabel} />
            {coding.decidedAt != null ? (
              <Fact
                label="Decided"
                value={`${coding.decidedByName ?? "—"} · ${when(coding.decidedAt)}`}
              />
            ) : null}
            {/* A reviewer corrected this after it was submitted. Shown BESIDE
                "Coded by", never instead of it: the author is still the
                author, and the next person to read this record is owed the
                fact that it isn't verbatim what was submitted. The sentence
                is never what changed — `reviseUnderReview` cannot reach
                `businessPurpose`. */}
            {coding.revisedAt != null ? (
              <Fact
                label="Amended in review"
                value={`${coding.revisedByName ?? "a reviewer"} · ${when(coding.revisedAt)}`}
              />
            ) : null}
          </View>
          {coding.reviewNote ? (
            <View className="mt-1 rounded-lg border border-border bg-raised px-3 py-2">
              <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                Last sent back with
              </Text>
              <Text className="text-xs italic text-ink">
                “{coding.reviewNote}”
              </Text>
            </View>
          ) : null}
          {coding.portedFromReimbursementId ? (
            <Text className="text-2xs text-muted">
              These are the claimant&apos;s own approved answers, carried over
              from their reimbursement request — not something typed here.
            </Text>
          ) : null}
        </Block>
      ) : null}

      {viewing ? (
        <FileViewer
          uri={viewing.url}
          visible
          caption="Evidence of purchase — not a receipt"
          contentType={viewing.contentType}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </View>
  );
}
