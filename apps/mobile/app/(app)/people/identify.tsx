/**
 * PEOPLE → IDENTIFY (`/people/identify`) — the human review queue for guest
 * identity linking. Partiful RSVPs arrive as a bare name with no email/phone,
 * so they never link to a `people` row: this screen is where a human
 * resolves the ones the auto-link migration (`migrations/0049`) couldn't.
 * Its own route (not a modal/sheet) so it's deep-linkable and shareable —
 * "go work the identify queue" is a link, not a set of clicks. The People
 * header's "Identify" entry point (added on the sibling
 * `feat/people-crm-overhaul` branch) routes here; this branch owns only the
 * screen itself.
 *
 * Never auto-links on a name — every name match ALWAYS goes to a human (see
 * `apps/convex/lib/rsvpPeople.ts` for the identifier-only auto-link pass).
 * Access is "anyone logged in on the team" today (`lib/identityAccess.ts`),
 * so any signed-in teammate can work this queue collaboratively.
 *
 * Four buckets, three card shapes, served in order:
 *  1. Auto-linked by the migration — never appears here.
 *  2 + 3. Name matches + duplicate people (~62 in prod) — high confidence,
 *     shown first as `IdentifyMatchCard` ("Same person?").
 *  4. Unidentified guests with no candidate at all (~1,179 in prod) — shown
 *     last, ordered by event count descending, as `IdentifyUnidentifiedCard`
 *     ("who is this?").
 *
 * A "same"/"different" verdict is committed to the server and the item then
 * disappears from the underlying REACTIVE query on its own (linked/merged
 * away, or suppressed via the evidence-hash check in
 * `apps/convex/identity.ts`) — this screen never removes an item from a
 * queue array itself. "Not sure"/"Don't know" record nothing server-side;
 * they only reorder THIS session's display via `lib/identifyQueue.ts`'s
 * `applySkipOrder` (see that module's doc for why).
 *
 * Position math: `resolved + remaining` is a session-stable "total" for each
 * bucket even though `remaining` shrinks live as the reactive query drops
 * resolved rows — see the per-bucket `*Total` computations below.
 *
 * Bucket 4 is paginated (never `.collect()`s the whole rsvps table
 * server-side — see `identity.ts`'s SCAN_CAP doc); pages accumulate locally
 * as the reviewer works through them, since there is no `usePaginatedQuery`
 * convention in this app (this whole codebase fetches per-screen lists with
 * plain `useQuery`, see `app/(app)/(tabs)/people.tsx`).
 *
 * Known limitation (matches `identity.ts#createPersonFromGuest`'s own
 * documented caveat): the "Might be" search below reads `api.people.list`,
 * which infers the chapter from the CALLER's own membership, not from a
 * peeked chapter — a central-seat holder peeking into another chapter's
 * queue would search their OWN roster, not the peeked one. Fine for the
 * common case (a chapter member working their own queue); flagged rather
 * than solved here, same as the mutation-side gap.
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { EmptyState, Narrow, ProgressBar, Screen, SectionHeader } from "../../../components/ui";
import { useChapterContext } from "../../../lib/ChapterContext";
import { alertError } from "../../../lib/errors";
import { IdentifyMatchCard } from "../../../components/people/IdentifyMatchCard";
import { IdentifyUnidentifiedCard } from "../../../components/people/IdentifyUnidentifiedCard";
import {
  applySkipOrder,
  buildHighConfidenceQueue,
  pickMergeDirection,
  pushToBack,
  type UnidentifiedRow,
} from "../../../lib/identifyQueue";

const PAGE_SIZE = 20;

function chapterIdFromContext(
  context: ReturnType<typeof useChapterContext>["context"],
): Id<"chapters"> | undefined {
  if (!context) return undefined;
  if (context.kind === "peek") return context.chapterId;
  if (context.kind === "seat" && context.scope !== "central") return context.scope;
  return undefined;
}

export default function IdentifyScreen() {
  const { context } = useChapterContext();
  const chapterId = chapterIdFromContext(context);

  const nameMatches = useQuery(
    api.identity.listNameMatchCandidates,
    chapterId ? { chapterId } : "skip",
  );
  const duplicates = useQuery(
    api.identity.listDuplicatePersonCandidates,
    chapterId ? { chapterId } : "skip",
  );
  const roster = useQuery(api.people.list, chapterId ? { persona: "all" } : "skip");

  // Bucket 4 pagination — pages accumulate locally (see module doc).
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedUnidentified, setLoadedUnidentified] = useState<UnidentifiedRow[]>([]);
  const [serverIsDone, setServerIsDone] = useState(false);
  const [totalUnidentifiedLive, setTotalUnidentifiedLive] = useState(0);
  const unidentifiedPage = useQuery(
    api.identity.listUnidentifiedGuests,
    chapterId ? { chapterId, paginationOpts: { numItems: PAGE_SIZE, cursor } } : "skip",
  );

  useEffect(() => {
    if (!unidentifiedPage) return;
    setLoadedUnidentified((prev) => {
      const known = new Set(prev.map((r) => r.nameKey));
      const additions = unidentifiedPage.page.filter((r) => !known.has(r.nameKey));
      return additions.length ? [...prev, ...additions] : prev;
    });
    setServerIsDone(unidentifiedPage.isDone);
    setTotalUnidentifiedLive(unidentifiedPage.totalCount);
  }, [unidentifiedPage]);

  const [hcSkipped, setHcSkipped] = useState<string[]>([]);
  const [hcResolvedCount, setHcResolvedCount] = useState(0);

  const [resolvedUnidentifiedKeys, setResolvedUnidentifiedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [unidentifiedSkipped, setUnidentifiedSkipped] = useState<string[]>([]);
  const [unidentifiedResolvedCount, setUnidentifiedResolvedCount] = useState(0);

  const [doneToday, setDoneToday] = useState(0);
  const [busy, setBusy] = useState(false);

  const hcQueue = useMemo(
    () => buildHighConfidenceQueue(nameMatches ?? [], duplicates ?? []),
    [nameMatches, duplicates],
  );
  const orderedHc = useMemo(
    () => applySkipOrder(hcQueue, (c) => c.key, hcSkipped),
    [hcQueue, hcSkipped],
  );
  // resolved + remaining = a session-stable total even though `remaining`
  // shrinks live as resolved rows drop out of the reactive query.
  const hcTotal = hcResolvedCount + hcQueue.length;

  const visibleUnidentified = useMemo(
    () => loadedUnidentified.filter((r) => !resolvedUnidentifiedKeys.has(r.nameKey)),
    [loadedUnidentified, resolvedUnidentifiedKeys],
  );
  const orderedUnidentified = useMemo(
    () => applySkipOrder(visibleUnidentified, (r) => r.nameKey, unidentifiedSkipped),
    [visibleUnidentified, unidentifiedSkipped],
  );
  const unidentifiedTotal = unidentifiedResolvedCount + totalUnidentifiedLive;

  // Fetch the next page once everything currently loaded has been resolved
  // or is only sitting in the skip tail with nothing left ahead of it, and
  // the server says there's more.
  useEffect(() => {
    if (!serverIsDone && visibleUnidentified.length === 0 && loadedUnidentified.length > 0) {
      const next = unidentifiedPage?.continueCursor ?? null;
      if (next !== cursor) setCursor(next);
    }
  }, [visibleUnidentified.length, serverIsDone, loadedUnidentified.length, unidentifiedPage, cursor]);

  const linkGuestToPerson = useMutation(api.identity.linkGuestToPerson);
  const createPersonFromGuest = useMutation(api.identity.createPersonFromGuest);
  const recordDecision = useMutation(api.identity.recordDecision);
  const mergeDuplicatePeople = useMutation(api.identity.mergeDuplicatePeople);

  async function commit(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setDoneToday((n) => n + 1);
    } catch (err) {
      alertError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!chapterId) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="user-check"
            title="Pick a chapter"
            message="Identify works one chapter's queue at a time — switch to (or peek into) a chapter first."
          />
        </Narrow>
      </Screen>
    );
  }

  const stillLoading =
    nameMatches === undefined ||
    duplicates === undefined ||
    (unidentifiedPage === undefined && loadedUnidentified.length === 0);

  const currentHc = orderedHc[0] ?? null;
  const currentUnidentified = !currentHc ? orderedUnidentified[0] ?? null : null;

  const totalRemaining = hcQueue.length + totalUnidentifiedLive;
  const progressFraction =
    doneToday + totalRemaining > 0 ? doneToday / (doneToday + totalRemaining) : 0;

  return (
    <Screen loading={stillLoading}>
      <Narrow>
        <SectionHeader title="Identify" />

        <View className="mb-4 flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-ink">{hcQueue.length} need a look</Text>
          <Text className="text-sm font-semibold text-ink">
            {totalUnidentifiedLive.toLocaleString()} unidentified
          </Text>
        </View>
        <View className="mb-5 gap-1.5">
          <ProgressBar fraction={progressFraction} />
          <Text className="text-xs text-muted">{doneToday} done today</Text>
        </View>

        {currentHc ? (
          <IdentifyMatchCard
            key={currentHc.key}
            card={currentHc}
            position={hcResolvedCount + 1}
            total={hcTotal}
            busy={busy}
            onSame={() => {
              if (currentHc.kind === "name_match") {
                void commit(async () => {
                  await linkGuestToPerson({
                    chapterId,
                    guestNameKey: currentHc.row.guestNameKey,
                    personId: currentHc.row.candidate._id,
                  });
                  setHcResolvedCount((n) => n + 1);
                });
              } else {
                const { fromId, toId } = pickMergeDirection(currentHc.row.subject, currentHc.row.candidate);
                void commit(async () => {
                  await mergeDuplicatePeople({ chapterId, fromId, toId });
                  setHcResolvedCount((n) => n + 1);
                });
              }
            }}
            onDifferent={() => {
              if (currentHc.kind === "name_match") {
                void commit(async () => {
                  await recordDecision({
                    chapterId,
                    kind: "guest_link",
                    subjectKey: currentHc.row.guestNameKey,
                    candidatePersonId: currentHc.row.candidate._id,
                    verdict: "different",
                  });
                  setHcResolvedCount((n) => n + 1);
                });
              } else {
                const { fromId, toId } = pickMergeDirection(currentHc.row.subject, currentHc.row.candidate);
                void commit(async () => {
                  await recordDecision({
                    chapterId,
                    kind: "person_merge",
                    subjectKey: String(fromId),
                    candidatePersonId: toId,
                    verdict: "different",
                  });
                  setHcResolvedCount((n) => n + 1);
                });
              }
            }}
            onNotSure={() => setHcSkipped((prev) => pushToBack(prev, currentHc.key))}
          />
        ) : currentUnidentified ? (
          <IdentifyUnidentifiedCard
            key={currentUnidentified.nameKey}
            row={currentUnidentified}
            position={unidentifiedResolvedCount + 1}
            total={unidentifiedTotal}
            people={roster ?? []}
            busy={busy}
            onPickExisting={(personId) =>
              void commit(async () => {
                await linkGuestToPerson({
                  chapterId,
                  guestNameKey: currentUnidentified.nameKey,
                  personId: personId as Id<"people">,
                });
                setResolvedUnidentifiedKeys((prev) => new Set(prev).add(currentUnidentified.nameKey));
                setUnidentifiedResolvedCount((n) => n + 1);
              })
            }
            onCreateNew={(fields) =>
              void commit(async () => {
                await createPersonFromGuest({
                  chapterId,
                  guestNameKey: currentUnidentified.nameKey,
                  ...fields,
                });
                setResolvedUnidentifiedKeys((prev) => new Set(prev).add(currentUnidentified.nameKey));
                setUnidentifiedResolvedCount((n) => n + 1);
              })
            }
            onDontKnow={() =>
              setUnidentifiedSkipped((prev) => pushToBack(prev, currentUnidentified.nameKey))
            }
          />
        ) : !stillLoading ? (
          <EmptyState
            icon="check-circle"
            title="All caught up"
            message="Nothing left to review right now — new guests will show up here as they RSVP."
          />
        ) : null}
      </Narrow>
    </Screen>
  );
}
