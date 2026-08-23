/**
 * PEOPLE · One candidate's file — everything a director needs to run the
 * Academy's process on one person, and nothing that would let them skip a
 * step.
 *
 * The five affordances map 1:1 to the process (`@events-os/shared`'s
 * `hiring.ts`):
 *   · Move the file        → the open stages, in order.
 *   · File a rubric review → the SAME five criteria at every meeting and every
 *                            trial review, in the tiebreak order character
 *                            first. Not a score to average — evidence.
 *   · Start the trial      → track + a brief that states the bounded work.
 *   · Make the call        → gated on `hiring.approve`, with the outcome
 *                            message pre-filled from the shared template and
 *                            fully editable before it sends.
 *   · Notes                → append-only; what someone thought in week one is
 *                            evidence, and evidence isn't edited.
 *
 * Every write is refused server-side too (`apps/convex/hiring.ts`) — the
 * disabled buttons here are courtesy, not enforcement.
 */
import { useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  APPLICATION_QUESTIONS,
  CANDIDATE_SOURCES,
  HIRING_OUTCOMES,
  HIRING_OUTCOME_DEFS,
  HIRING_STAGE_DEFS,
  MIN_REVIEWS_BEFORE_DECISION,
  OPEN_HIRING_STAGES,
  REVIEW_KINDS,
  REVIEW_KIND_LABELS,
  REVIEW_RECOMMENDATIONS,
  RUBRIC,
  RUBRIC_SCALE,
  TRIAL_BOUNDARIES,
  TRIAL_DELIVERABLE_PROMPT,
  TRIAL_TRACKS,
  isClosedStage,
  outcomeMessage,
  type HiringOutcome,
  type HiringStage,
  type ReviewKind,
  type RubricCriterion,
} from "@events-os/shared";
import {
  BackLink,
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  Select,
  SectionHeader,
  TextField,
} from "../../../../components/ui";
import { stageTone } from "../../../../lib/hiringStage";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ApplicationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const access = useQuery(api.hiring.myHiringAccess, {});
  const data = useQuery(api.hiring.getApplication, {
    applicationId: id as Id<"jobApplications">,
  });

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Hiring desk access needed"
            message="Ask the People Director or the ED for access to the hiring pipeline."
          />
        </Narrow>
      </Screen>
    );
  }
  if (data === undefined) return <Screen loading />;
  if (data === null) {
    return (
      <Screen>
        <Narrow>
          <BackLink fallback="/people/pipeline" label="Applications" />
          <EmptyState
            title="Not found"
            message="This application no longer exists."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <FileBody
      data={data}
      canManage={access.canManage}
      canDecide={access.canDecide}
    />
  );
}

type FileData = NonNullable<
  (typeof api.hiring.getApplication)["_returnType"]
>;

function FileBody({
  data,
  canManage,
  canDecide,
}: {
  data: FileData;
  canManage: boolean;
  canDecide: boolean;
}) {
  const app = data.application;
  const stage = app.stage as HiringStage;
  const closed = isClosedStage(stage);

  const advanceStage = useMutation(api.hiring.advanceStage);
  const claim = useMutation(api.hiring.claimApplication);
  const setSource = useMutation(api.hiring.setSource);
  const addNote = useMutation(api.hiring.addNote);
  const submitReview = useMutation(api.hiring.submitReview);
  const startTrial = useMutation(api.hiring.startTrial);
  const recordDecision = useMutation(api.hiring.recordDecision);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Every write goes through here so a refused mutation surfaces its
   *  server-written sentence (the gates and the rules both speak English)
   *  instead of failing silently. */
  async function guard(run: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await run();
      return true;
    } catch (err) {
      const message =
        (err as { data?: { message?: string } })?.data?.message ??
        "That didn't go through.";
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const reviewerCount = useMemo(
    () => new Set(data.reviews.map((r) => String(r.reviewerId))).size,
    [data.reviews],
  );

  return (
    <Screen>
      <Narrow>
        <BackLink fallback="/people/pipeline" label="Applications" />

        {/* ── Who, and where they are ─────────────────────────────── */}
        <View className="mb-3 mt-2 flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text className="text-xl font-semibold text-ink">{app.name}</Text>
            <Text className="mt-0.5 text-sm text-muted">{app.roleTitle}</Text>
          </View>
          <Badge label={HIRING_STAGE_DEFS[stage].label} tone={stageTone(stage)} />
        </View>
        <Text className="mb-3 text-xs text-muted">
          {HIRING_STAGE_DEFS[stage].blurb}
        </Text>

        <Card padding="md">
          <Text className="text-sm text-ink">{app.email}</Text>
          {app.phone ? (
            <Text className="mt-0.5 text-sm text-ink">{app.phone}</Text>
          ) : null}
          {app.location ? (
            <Text className="mt-0.5 text-xs text-muted">{app.location}</Text>
          ) : null}
          {app.links.length > 0 ? (
            <View className="mt-2 gap-0.5">
              {app.links.map((link) => (
                <Text key={link} className="text-xs text-accent" numberOfLines={1}>
                  {link}
                </Text>
              ))}
            </View>
          ) : null}
          {app.referredBy ? (
            <Text className="mt-2 text-xs text-muted">
              Referred by: {app.referredBy}
            </Text>
          ) : null}
          <Text className="mt-2 text-xs text-faint">
            Applied {formatDate(app.createdAt)}
          </Text>

          <View className="mt-3 flex-row flex-wrap items-center gap-2">
            <Badge
              label={
                app.assignedToName
                  ? `Owned by ${app.assignedToName}`
                  : "No owner"
              }
              tone={app.assignedTo ? "neutral" : "warn"}
            />
            {canManage ? (
              <Button
                size="sm"
                variant="secondary"
                title={app.assignedTo ? "Release" : "I'll own this"}
                disabled={busy}
                onPress={() =>
                  void guard(() =>
                    claim({
                      applicationId: app._id,
                      claim: !app.assignedTo,
                    }),
                  )
                }
              />
            ) : null}
          </View>

          {canManage ? (
            <View className="mt-3">
              <Select
                label="How they actually reached us"
                hint="The form can only ever say 'public call'. Re-file it honestly — the ordered search only measures anything if this is true."
                value={app.source}
                options={CANDIDATE_SOURCES.map((s) => ({
                  value: s.id,
                  label: `${s.rung} · ${s.label}`,
                }))}
                onChange={(value) =>
                  void guard(() =>
                    setSource({
                      applicationId: app._id,
                      source: value as (typeof CANDIDATE_SOURCES)[number]["id"],
                    }),
                  )
                }
              />
            </View>
          ) : null}
        </Card>

        {error ? (
          <View className="mt-3 rounded-md border border-danger bg-danger-bg px-3 py-2">
            <Text className="text-sm text-danger">{error}</Text>
          </View>
        ) : null}

        {/* ── The outcome, when there is one ──────────────────────── */}
        {app.outcome ? (
          <View className="mt-4">
            <Card padding="md">
              <Text className="text-sm font-semibold text-ink">
                {HIRING_OUTCOME_DEFS[app.outcome as HiringOutcome].label}
                {app.decidedAt ? ` · ${formatDate(app.decidedAt)}` : ""}
              </Text>
              {app.decisionReason ? (
                <Text className="mt-1 text-sm text-muted">
                  {app.decisionReason}
                </Text>
              ) : null}
              {app.revisitAt ? (
                <Text className="mt-1 text-xs text-muted">
                  Revisit {formatDate(app.revisitAt)}
                </Text>
              ) : null}
              {app.outcome !== "withdrawn" ? (
                <Text
                  className={`mt-2 text-xs ${app.outcomeMessageSentAt ? "text-muted" : "text-danger"}`}
                >
                  {app.outcomeMessageSentAt
                    ? `Message sent ${formatDate(app.outcomeMessageSentAt)}`
                    : "No outcome message has gone out — this person is still waiting to hear."}
                </Text>
              ) : null}
            </Card>
          </View>
        ) : null}

        {/* ── Their answers ───────────────────────────────────────── */}
        <SectionHeader title="What they said" />
        <View className="gap-2">
          {APPLICATION_QUESTIONS.map((q) => {
            const answer = app.answers[q.key];
            if (!answer) return null;
            return (
              <Card key={q.key} padding="md">
                <Text className="text-xs font-semibold text-muted">
                  {q.label}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-ink">{answer}</Text>
              </Card>
            );
          })}
        </View>

        {/* ── Have we met them before? ────────────────────────────── */}
        {data.otherApplications.length > 0 ? (
          <>
            <SectionHeader title="We've talked before" />
            <View className="gap-1">
              {data.otherApplications.map((other) => (
                <Text key={other._id} className="text-xs text-muted">
                  {other.roleTitle} ·{" "}
                  {HIRING_STAGE_DEFS[other.stage as HiringStage].label} ·{" "}
                  {formatDate(other.createdAt)}
                </Text>
              ))}
            </View>
          </>
        ) : null}

        {/* ── Move the file ───────────────────────────────────────── */}
        {canManage ? (
          <>
            <SectionHeader
              title="Move this file"
              count={closed ? "closed" : undefined}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
            >
              {OPEN_HIRING_STAGES.filter((s) => s !== stage).map((s) => (
                <Pressable
                  key={s}
                  disabled={busy}
                  onPress={() =>
                    void guard(() =>
                      advanceStage({ applicationId: app._id, stage: s }),
                    )
                  }
                  className="rounded-md border border-border-strong bg-raised px-3 py-2"
                >
                  <Text className="text-sm text-ink">
                    {HIRING_STAGE_DEFS[s].label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        ) : null}

        {/* ── The trial ───────────────────────────────────────────── */}
        {app.trialStartedAt ? (
          <>
            <SectionHeader title="Empowerment Trial" />
            <Card padding="md">
              <Text className="text-sm font-semibold text-ink">
                {TRIAL_TRACKS.find((t) => t.id === app.trialTrack)?.label} track
              </Text>
              <Text className="mt-1 text-xs text-muted">
                Started {formatDate(app.trialStartedAt)}
                {app.trialMidpointDueAt
                  ? ` · midpoint ${formatDate(app.trialMidpointDueAt)}`
                  : ""}
                {app.trialDecisionDueAt
                  ? ` · decision ${formatDate(app.trialDecisionDueAt)}`
                  : ""}
              </Text>
              {app.trialBrief ? (
                <Text className="mt-2 text-sm leading-5 text-ink">
                  {app.trialBrief}
                </Text>
              ) : null}
            </Card>
          </>
        ) : canManage ? (
          <TrialStarter
            busy={busy}
            onStart={(track, brief) =>
              guard(() =>
                startTrial({ applicationId: app._id, track, brief }),
              )
            }
          />
        ) : null}

        {/* ── The rubric ──────────────────────────────────────────── */}
        <SectionHeader
          title="Rubric"
          count={`${reviewerCount}/${MIN_REVIEWS_BEFORE_DECISION} reviewers`}
        />
        <Text className="mb-2 text-xs text-muted">
          The same five, in this order, at every meeting and every trial review.
          When two people are close, character breaks the tie — skill can be
          trained, heart can't.
        </Text>
        {data.reviews.length > 0 ? (
          <View className="mb-3 gap-2">
            {data.reviews.map((review) => (
              <Card key={review._id} padding="md">
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="flex-1 text-sm font-semibold text-ink">
                    {review.reviewerName ?? "A reviewer"}
                  </Text>
                  <Badge
                    label={review.recommendation}
                    tone={
                      review.recommendation === "advance"
                        ? "success"
                        : review.recommendation === "decline"
                          ? "danger"
                          : "warn"
                    }
                  />
                </View>
                <Text className="text-xs text-muted">
                  {REVIEW_KIND_LABELS[review.kind as ReviewKind]} ·{" "}
                  {formatDate(review.createdAt)}
                </Text>
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {RUBRIC.map((c) => {
                    const value = review.ratings[c.id];
                    if (typeof value !== "number") return null;
                    return (
                      <Text key={c.id} className="text-xs text-ink">
                        {c.label} {value}/4
                      </Text>
                    );
                  })}
                </View>
                {review.notes ? (
                  <Text className="mt-2 text-sm leading-5 text-ink">
                    {review.notes}
                  </Text>
                ) : null}
              </Card>
            ))}
          </View>
        ) : null}
        {canManage ? (
          <ReviewForm
            busy={busy}
            onSubmit={(args) =>
              guard(() => submitReview({ applicationId: app._id, ...args }))
            }
          />
        ) : null}

        {/* ── The call ────────────────────────────────────────────── */}
        {canDecide && !closed ? (
          <DecisionForm
            busy={busy}
            candidateName={app.name}
            roleTitle={app.roleTitle}
            onDecide={(args) =>
              guard(() => recordDecision({ applicationId: app._id, ...args }))
            }
          />
        ) : null}

        {/* ── Notes + timeline ────────────────────────────────────── */}
        {canManage ? (
          <NoteForm
            busy={busy}
            onAdd={(body) => guard(() => addNote({ applicationId: app._id, body }))}
          />
        ) : null}

        <SectionHeader title="Timeline" />
        <View className="gap-2 pb-6">
          {data.events.map((event) => (
            <View key={event._id} className="border-l-2 border-border pl-3">
              <Text className="text-xs text-muted">
                {formatDate(event.at)}
                {event.actorName ? ` · ${event.actorName}` : ""}
                {event.toStage
                  ? ` · → ${HIRING_STAGE_DEFS[event.toStage as HiringStage].label}`
                  : ""}
              </Text>
              {event.body ? (
                <Text className="mt-0.5 text-sm leading-5 text-ink">
                  {event.body}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      </Narrow>
    </Screen>
  );
}

/** Start the trial: pick a track, state the bounded work. The boundaries and
 *  the playbook ask are printed rather than left to memory — they are the two
 *  things a rushed brief always drops. */
function TrialStarter({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (track: "team_member" | "director", brief: string) => Promise<boolean>;
}) {
  const [track, setTrack] = useState<"team_member" | "director">("team_member");
  const [brief, setBrief] = useState("");
  const def = TRIAL_TRACKS.find((t) => t.id === track)!;

  return (
    <>
      <SectionHeader title="Start the Empowerment Trial" />
      <Card padding="md">
        <Select
          label="Track"
          value={track}
          options={TRIAL_TRACKS.map((t) => ({
            value: t.id,
            label: `${t.label} — midpoint at ${t.midpointDays} days, decision at ${t.decisionDays}`,
          }))}
          onChange={(value) => setTrack(value as "team_member" | "director")}
        />
        <TextField
          label="The brief"
          hint={TRIAL_DELIVERABLE_PROMPT}
          value={brief}
          onChangeText={setBrief}
          multiline
          numberOfLines={4}
          placeholder="Real, bounded work: what they're doing, what done looks like, and what they get to decide."
        />
        <Text className="mb-2 text-xs text-muted">
          Bounded, deliberately: {TRIAL_BOUNDARIES.join(" · ")}.
        </Text>
        <Button
          title={`Start the ${def.label.toLowerCase()} trial`}
          disabled={busy || brief.trim().length === 0}
          onPress={() => {
            void onStart(track, brief).then((ok) => {
              if (ok) setBrief("");
            });
          }}
        />
      </Card>
    </>
  );
}

/** File one rubric card. One per reviewer per meeting — filing again replaces
 *  your own card rather than counting twice. */
function ReviewForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (args: {
    kind: ReviewKind;
    ratings: Record<string, number>;
    notes?: string;
    recommendation: "advance" | "hold" | "decline";
  }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<ReviewKind>("interview_heart");
  const [ratings, setRatings] = useState<Partial<Record<RubricCriterion, number>>>(
    {},
  );
  const [notes, setNotes] = useState("");
  const [recommendation, setRecommendation] = useState<
    "advance" | "hold" | "decline"
  >("advance");

  const rated = Object.keys(ratings).length;

  return (
    <Card padding="md">
      <Text className="mb-2 text-sm font-semibold text-ink">
        File your review
      </Text>
      <Select
        label="Which meeting"
        value={kind}
        options={REVIEW_KINDS.map((k) => ({
          value: k,
          label: REVIEW_KIND_LABELS[k],
        }))}
        onChange={(value) => setKind(value as ReviewKind)}
      />
      <View className="gap-3">
        {RUBRIC.map((criterion) => (
          <View key={criterion.id}>
            <Text className="text-sm font-semibold text-ink">
              {criterion.label}
            </Text>
            <Text className="mb-1 text-xs text-muted">{criterion.prompt}</Text>
            <View className="flex-row flex-wrap gap-2">
              {RUBRIC_SCALE.map((step) => {
                const selected = ratings[criterion.id] === step.value;
                return (
                  <Pressable
                    key={step.value}
                    onPress={() =>
                      setRatings((prev) => {
                        const next = { ...prev };
                        // Tapping the selected value clears it — "we never saw
                        // this" is a real answer, and it isn't a 1.
                        if (next[criterion.id] === step.value) {
                          delete next[criterion.id];
                        } else {
                          next[criterion.id] = step.value;
                        }
                        return next;
                      })
                    }
                    className={`rounded-md border px-2.5 py-1.5 ${
                      selected
                        ? "border-accent bg-accent-soft"
                        : "border-border-strong bg-raised"
                    }`}
                  >
                    <Text
                      className={`text-xs ${selected ? "text-accent" : "text-muted"}`}
                    >
                      {step.value} · {step.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </View>
      <View className="mt-3">
        <TextField
          label="What you saw"
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          placeholder="Specifics beat impressions."
        />
        <Select
          label="Your read"
          hint="A recommendation, not a decision — the Director makes the call."
          value={recommendation}
          options={REVIEW_RECOMMENDATIONS.map((r) => ({ value: r, label: r }))}
          onChange={(value) =>
            setRecommendation(value as "advance" | "hold" | "decline")
          }
        />
        <Button
          title="File this review"
          disabled={busy || rated === 0}
          onPress={() => {
            void onSubmit({
              kind,
              ratings: ratings as Record<string, number>,
              ...(notes.trim() ? { notes } : {}),
              recommendation,
            }).then((ok) => {
              if (ok) {
                setRatings({});
                setNotes("");
              }
            });
          }}
        />
      </View>
    </Card>
  );
}

/** The call. The message is pre-filled from the shared template the moment an
 *  outcome is picked, and is fully editable — templated so nobody has to find
 *  the words for a hard no at 11pm, editable so it never becomes a form
 *  letter. */
function DecisionForm({
  busy,
  candidateName,
  roleTitle,
  onDecide,
}: {
  busy: boolean;
  candidateName: string;
  roleTitle: string;
  onDecide: (args: {
    outcome: HiringOutcome;
    reason: string;
    revisitAt?: number;
    message?: string;
    sendMessage: boolean;
  }) => Promise<boolean>;
}) {
  const [outcome, setOutcome] = useState<HiringOutcome | null>(null);
  const [reason, setReason] = useState("");
  const [revisitDate, setRevisitDate] = useState("");
  const [message, setMessage] = useState("");
  const [send, setSend] = useState(true);

  const def = outcome ? HIRING_OUTCOME_DEFS[outcome] : null;

  function pick(next: HiringOutcome): void {
    setOutcome(next);
    setMessage(
      outcomeMessage(next, {
        candidateName,
        roleTitle,
        ...(revisitDate ? { revisitLabel: revisitDate } : {}),
      }) ?? "",
    );
  }

  const revisitMs = revisitDate ? Date.parse(revisitDate) : NaN;
  const revisitValid = !Number.isNaN(revisitMs);

  return (
    <>
      <SectionHeader title="Make the call" />
      <Card padding="md">
        <View className="mb-3 flex-row flex-wrap gap-2">
          {HIRING_OUTCOMES.map((o) => (
            <Pressable
              key={o}
              onPress={() => pick(o)}
              className={`rounded-md border px-3 py-2 ${
                outcome === o
                  ? "border-accent bg-accent-soft"
                  : "border-border-strong bg-raised"
              }`}
            >
              <Text
                className={`text-sm ${outcome === o ? "text-accent" : "text-ink"}`}
              >
                {HIRING_OUTCOME_DEFS[o].label}
              </Text>
            </Pressable>
          ))}
        </View>

        {outcome ? (
          <>
            <TextField
              label="Why — for us, not for them"
              hint="Recorded on the file, never sent. In six months this is the only thing that makes re-opening it honest."
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
            />
            {def?.requiresRevisitDate ? (
              <TextField
                label="Come back to this on"
                hint="YYYY-MM-DD. A not-now without a date is a no nobody had to say."
                value={revisitDate}
                onChangeText={setRevisitDate}
                placeholder="2027-01-15"
              />
            ) : null}
            {def?.messagesCandidate ? (
              <>
                <TextField
                  label="What they'll read"
                  hint="Drafted for you. Edit it until it sounds like you — a form letter is worse than a late reply."
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  numberOfLines={8}
                />
                <Pressable
                  onPress={() => setSend((s) => !s)}
                  className="mb-3 flex-row items-center gap-2"
                >
                  <View
                    className={`h-4 w-4 rounded-sm border ${
                      send ? "border-accent bg-accent" : "border-border-strong"
                    }`}
                  />
                  <Text className="text-sm text-ink">
                    Email this to them now
                  </Text>
                </Pressable>
              </>
            ) : null}
            <Button
              title={def?.label ?? "Record the decision"}
              disabled={
                busy ||
                reason.trim().length === 0 ||
                (def?.requiresRevisitDate === true && !revisitValid) ||
                (def?.messagesCandidate === true &&
                  send &&
                  message.trim().length === 0)
              }
              onPress={() => {
                void onDecide({
                  outcome,
                  reason,
                  ...(def?.requiresRevisitDate && revisitValid
                    ? { revisitAt: revisitMs }
                    : {}),
                  ...(message.trim() ? { message } : {}),
                  sendMessage: send,
                });
              }}
            />
          </>
        ) : null}
      </Card>
    </>
  );
}

function NoteForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  return (
    <Card padding="md">
      <TextField
        label="Add a note"
        value={body}
        onChangeText={setBody}
        multiline
        numberOfLines={3}
        placeholder="What happened, what you're waiting on, what you promised them."
      />
      <Button
        title="Add note"
        size="sm"
        disabled={busy || body.trim().length === 0}
        onPress={() => {
          void onAdd(body).then((ok) => {
            if (ok) setBody("");
          });
        }}
      />
    </Card>
  );
}
