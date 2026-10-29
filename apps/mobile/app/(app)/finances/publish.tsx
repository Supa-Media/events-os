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
 *
 * ── THIS ROUTE IS ONE OF TWO FRAMES NOW ──────────────────────────────────────
 * The month body moved to `components/finance/publish/PublishMonth.tsx` so the
 * Transactions grid can open the SAME flow in a modal over a month band
 * (founder, 2026-08-14: "I want to be able to preview and publish from the
 * same page"). Nothing about the act changed or thinned — one implementation,
 * two frames.
 *
 * THE ROUTE STAYS, and not only for old links: it is what the Dashboard's
 * publishability card points at, it is the calendar view of a whole book (the
 * grid shows only the months its rows fall in), and it is where the merged
 * all-books queue sends a publisher, because a book has to be chosen
 * explicitly before one month of it can go public.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { parsePeriodKey } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../components/ui";
import { FinanceBoundary } from "../../../components/finance/dashboard/parts";
import { useChapterContext } from "../../../lib/ChapterContext";
import { resolveBookScope } from "../../../components/finance/bookScope";
import { BookScopeNotice } from "../../../components/finance/BookScopeNotice";
import {
  PublishMonthBody,
  PublishMonthNotes,
  type PublishBookScope,
  type PublishMonthSummary,
} from "../../../components/finance/publish/PublishMonth";
import { publicationBadge } from "../../../components/finance/publish/publishBandAction";

function NoAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Restricted"
      message="Only a finance seat can work the publish queue."
    />
  );
}

export default function PublishScreen() {
  return (
    <FinanceBoundary fallback={<NoAccess />}>
      <Body />
    </FinanceBoundary>
  );
}

function Body() {
  const params = useLocalSearchParams<{ scope?: string; period?: string }>();
  const router = useRouter();
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
  //
  // But `?scope=` is written by the reconcile grid, which speaks a
  // WIDER vocabulary than `publicLedger`'s `scopeValidator`
  // (`v.id("chapters") | "central"`) accepts — its default for a dual-hat
  // caller is `"all"`, the merged queue, and there is no such thing as
  // publishing "all books" as one month. Handed over raw it failed argument
  // validation before the handler ran — not a `ConvexError`, so
  // `FinanceBoundary` never saw it and the screen died with a bare "Server
  // Error" (2026-08-13). `resolveBookScope` degrades anything unusable to the
  // caller's own desk and REPORTS it, so the banner below can name the book
  // actually on screen. See `components/finance/bookScope.ts`.
  const desk =
    context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat"
        ? context.scope
        : null;
  const resolved = resolveBookScope(params.scope, desk);
  const scope = resolved.scope;

  // NO `as never`. `scope` is `SingleBookScope | null` (`Id<"chapters">` is a
  // BRANDED string), so the compiler now rejects a grid word at this call
  // site rather than production doing it. `null` OMITS the field — an
  // explicit null fails `v.optional`.
  const data = useQuery(api.publicLedger.console_, scope ? { scope } : {});
  // WHICH MONTH OPENS EXPANDED. `?period=` is honoured so a link that meant one
  // month lands ON that month rather than on a list of eighteen with the reader
  // left to find it — the reconcile grid's month bands now link straight here
  // from a band that already named the month, and dropping that context at the
  // door is how a one-tap handoff turns into a scroll.
  //
  // Validated, not trusted: an unparseable `?period=` collapses to "nothing
  // expanded", which is exactly the state this screen has always opened in.
  // Read once as the INITIAL state rather than as a controlled value, so
  // expanding a different month afterwards isn't fought by the URL.
  const [open, setOpen] = useState<string | null>(() =>
    params.period && parsePeriodKey(params.period) ? params.period : null,
  );

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
        {/* THE URL ASKED FOR A BOOK THIS SCREEN CAN'T OPEN. Above the month
            list, never below it: on the one screen that puts numbers in front
            of the whole city, "which book is this" has to be settled before
            anything is read, let alone submitted for review. Named with the
            server's own `scopeName`, so the correction can't itself be
            wrong. */}
        <BookScopeNotice
          resolved={resolved}
          showingName={data.scopeName}
          onPick={(next) => router.setParams({ scope: next })}
        />
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

function MonthRow({
  month,
  scope,
  canPublish,
  expanded,
  onToggle,
}: {
  month: PublishMonthSummary;
  scope: PublishBookScope;
  canPublish: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  // The SAME badge the grid's month band and the in-place modal render — one
  // sentence about where a month stands, so the three places it is shown
  // cannot say it three ways. It names the live revision, which the separate
  // "rev N" line beside it used to do only from revision 2 on.
  const badge = publicationBadge({
    status: month.status,
    liveRevision: month.liveRevision,
  });
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-base font-semibold text-ink">{month.label}</Text>
        <Badge tone={badge.tone} label={badge.label} />
        <Button
          variant="ghost"
          size="sm"
          title={expanded ? "Hide" : "Open"}
          onPress={onToggle}
        />
      </View>
      <PublishMonthNotes month={month} />
      {expanded ? (
        <PublishMonthBody month={month} scope={scope} canPublish={canPublish} />
      ) : null}
    </Card>
  );
}
