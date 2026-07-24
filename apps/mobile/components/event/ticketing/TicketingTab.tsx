/**
 * Admin "RSVP page" tab — the whole shareable-RSVP-page control panel, framed
 * as a four-phase LAUNCH FLOW instead of one long scroll of equal cards:
 *
 *   Design → Publish → Grow → Run
 *
 * A stepper tracks progress; one phase is open at a time. Each phase folds in the
 * work you'd do at that stage — Design (page setup + tickets + giving), Publish
 * (go-live + link), Grow (blasts + guest list), Run (door check-in + giving
 * ledger). The live "pulse" strip appears once the page is published, when its
 * numbers start to mean something. Rendered by event/[id].tsx when active.
 */
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ProgressBar,
  TextField,
} from "../../ui";
import { ToastView } from "../../ui/Toast";
import { useActionRunner, type ActionRunner } from "../../../lib/useActionToast";
import { formatDateTime } from "../../../lib/format";
import { DesignPhase } from "./DesignPhase";
import { GivingCard } from "./GivingCard";
import { GuestListCard, type GuestFilter } from "./GuestListCard";
import { ImportAttendanceCard } from "./ImportAttendanceCard";
import { CheckInCard } from "./CheckInCard";
import { BlastComposerCard } from "./BlastComposerCard";
import { LaunchStepper } from "./LaunchStepper";
import { PhaseSection } from "./PhaseSection";
import {
  LAUNCH_PHASES,
  launchPhaseState,
  defaultOpenPhase,
  type LaunchPhaseKey,
} from "./launchPhases";
import { rsvpPageUrl, formatMoney } from "./helpers";

export default function TicketingTab({ eventId }: { eventId: Id<"events"> }) {
  const { run, toast, dismiss } = useActionRunner();
  const data = useQuery(api.ticketing.getAdminPage, { eventId });
  const createPage = useMutation(api.ticketing.createPage);
  const [creating, setCreating] = useState(false);
  // `undefined` = untouched (fall back to the computed default phase);
  // `null` = the user collapsed everything; a key = that phase is open.
  const [openPhase, setOpenPhase] = useState<
    LaunchPhaseKey | null | undefined
  >(undefined);
  // Deep-links a pulse-strip tap into the guest list's filter chips. A fresh
  // wrapper object per tap (never a bare string) so re-tapping the same stat
  // re-applies the filter even after the user tapped other chips.
  const [guestFilter, setGuestFilter] = useState<
    { value: GuestFilter } | undefined
  >(undefined);

  if (data === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading event page…</Text>
      </View>
    );
  }

  const { page, ticketTypes, coverUrl } = data;

  if (page === null) {
    return (
      <View className="mt-4">
        <EmptyState
          icon="globe"
          title="Put this event on the map"
          message="Create a shareable RSVP page with RSVPs, tickets & a guest feed — one link your whole audience can open."
          action={
            <Button
              title="Create RSVP page"
              icon="plus"
              loading={creating}
              onPress={() => {
                setCreating(true);
                void run(() => createPage({ eventId }), {
                  errorTitle: "Couldn't create page",
                }).finally(() => setCreating(false));
              }}
            />
          }
        />
      </View>
    );
  }

  // Narrowed non-null captures — TS drops the `page === null` narrowing inside
  // the nested phaseBody closure below, so re-bind here.
  const pageRow = page;
  const ev = data.event;

  // Per-phase completion + status chips — pure derivation (see launchPhases).
  const { doneKeys, status } = launchPhaseState(page);
  // Default open phase = the first thing left to do, until the user taps around.
  const activePhase: LaunchPhaseKey | null =
    openPhase === undefined ? defaultOpenPhase(doneKeys) : openPhase;

  const togglePhase = (key: LaunchPhaseKey) =>
    setOpenPhase(key === activePhase ? null : key);

  // Tapping a pulse-strip stat jumps to Grow and pre-filters the guest list.
  const goToGuestFilter = (filter: GuestFilter) => {
    setOpenPhase("grow");
    setGuestFilter({ value: filter });
  };

  const dateLabel = ev?.eventDate ? formatDateTime(ev.eventDate) : null;

  function phaseBody(key: LaunchPhaseKey) {
    switch (key) {
      case "design":
        return (
          <DesignPhase
            eventId={eventId}
            page={pageRow}
            coverUrl={coverUrl}
            ticketTypes={ticketTypes}
            run={run}
            eventName={ev?.name ?? "Your event"}
            dateLabel={dateLabel}
          />
        );
      case "publish":
        return <PublishShareCard page={pageRow} run={run} />;
      case "grow":
        return (
          <View className="gap-5">
            <PhaseBlock label="Send a blast">
              <BlastComposerCard eventId={eventId} run={run} />
            </PhaseBlock>
            <PhaseBlock label="Guest list">
              <GuestListCard
                eventId={eventId}
                page={pageRow}
                initialFilter={guestFilter}
              />
            </PhaseBlock>
            <PhaseBlock label="Import attendance">
              <ImportAttendanceCard eventId={eventId} />
            </PhaseBlock>
          </View>
        );
      case "run":
        return (
          <View className="gap-5">
            <PhaseBlock label="Door check-in">
              <CheckInCard eventId={eventId} run={run} />
            </PhaseBlock>
            <PhaseBlock label="Giving">
              <GivingCard eventId={eventId} page={pageRow} run={run} />
            </PhaseBlock>
          </View>
        );
    }
  }

  return (
    <View>
      <ToastView toast={toast} onDismiss={dismiss} />

      {/* Live pulse — meaningful only once the page is live. */}
      {page.published ? (
        <View className="mb-3 flex-row flex-wrap gap-2">
          <StatCard
            label="Going"
            value={String(page.goingCount)}
            onPress={() => goToGuestFilter("going")}
          />
          <StatCard
            label="Maybe"
            value={String(page.maybeCount)}
            onPress={() => goToGuestFilter("maybe")}
          />
          <StatCard
            label="Tickets"
            value={String(page.ticketsSoldCount)}
            onPress={() => goToGuestFilter("ticket")}
          />
          <StatCard label="Revenue" value={formatMoney(page.revenueCents)} />
          {/* "Given" = on-page donations + external gifts (Givebutter/offline
              donations attributed to the event) — mirrors the schema's
              externalGiftsCents doc and the Goal card's raised total. */}
          <StatCard
            label="Given"
            value={formatMoney(
              (page.donationsCents ?? 0) + (page.externalGiftsCents ?? 0),
            )}
          />
          {page.goalCents != null ? (
            <GoalStatCard
              raisedCents={
                page.revenueCents +
                (page.donationsCents ?? 0) +
                (page.externalGiftsCents ?? 0)
              }
              goalCents={page.goalCents}
            />
          ) : null}
        </View>
      ) : null}

      {/* The spine */}
      <LaunchStepper
        activeKey={activePhase}
        doneKeys={doneKeys}
        onSelect={(key) => setOpenPhase(key)}
      />

      {/* The phases */}
      <View className="gap-3">
        {LAUNCH_PHASES.map((phase) => (
          <PhaseSection
            key={phase.key}
            phase={phase}
            status={status[phase.key]}
            open={activePhase === phase.key}
            onToggleOpen={() => togglePhase(phase.key)}
          >
            {phaseBody(phase.key)}
          </PhaseSection>
        ))}
      </View>
    </View>
  );
}

/** A small labelled block grouping one card inside a phase body. */
function PhaseBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View>
      <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      {children}
    </View>
  );
}

/** One small stat tile in the live "pulse" strip. Tappable tiles (Going,
 * Maybe, Tickets) jump to the guest list pre-filtered to who's behind the
 * number; Revenue/Given have no matching guest-list filter, so they stay
 * static. */
function StatCard({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  return (
    <Card padding="sm" className="min-w-[104px] flex-1" onPress={onPress}>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text className="mt-1 font-display text-xl text-ink">{value}</Text>
    </Card>
  );
}

/** Compact "$raised / $goal" tile + bar in the pulse strip — only shown once
 *  a fundraising goal is set (Accept donations → Fundraising goal). Wider
 *  than the plain stat tiles so the bar has room to read at a glance. */
function GoalStatCard({
  raisedCents,
  goalCents,
}: {
  raisedCents: number;
  goalCents: number;
}) {
  const fraction = goalCents > 0 ? raisedCents / goalCents : 0;
  return (
    <Card padding="sm" className="min-w-[160px] flex-1">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        Goal
      </Text>
      <Text className="mt-1 font-display text-xl text-ink">
        {formatMoney(raisedCents)} / {formatMoney(goalCents)}
      </Text>
      <View className="mt-2">
        <ProgressBar fraction={fraction} />
      </View>
    </Card>
  );
}

/** Publish toggle, the public link with copy, and slug editing. */
function PublishShareCard({
  page,
  run,
}: {
  page: Doc<"eventPages">;
  run: ActionRunner["run"];
}) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const ensurePreviewToken = useMutation(api.ticketing.ensurePreviewToken);
  const [slugInput, setSlugInput] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const slugValue = slugInput !== null ? slugInput : page.slug;
  const link = rsvpPageUrl(page.slug);

  async function saveSlug() {
    const next = slugValue.trim();
    if (next === "" || next === page.slug) {
      setSlugInput(null);
      return;
    }
    await run(() => updatePage({ pageId: page._id, patch: { slug: next } }), {
      errorTitle: "Couldn't change link",
    });
    setSlugInput(null);
  }

  /** Mint (or reuse) the page's secret preview token and open the draft-safe
   *  link — works whether the page is published or not, since it bypasses
   *  the "published" gate the plain link is subject to. */
  async function openPreview() {
    setPreviewLoading(true);
    const token = await run(() => ensurePreviewToken({ pageId: page._id }), {
      errorTitle: "Couldn't open preview",
    });
    setPreviewLoading(false);
    if (token) void Linking.openURL(`${link}?preview=${token}`);
  }

  return (
    <View>
      <View className="flex-row items-center gap-3">
        <Badge
          label={page.published ? "Live" : "Draft"}
          tone={page.published ? "success" : "neutral"}
        />
        <View className="flex-1" />
        <Button
          title={page.published ? "Unpublish" : "Publish"}
          icon={page.published ? "eye-off" : "globe"}
          variant={page.published ? "secondary" : "primary"}
          size="sm"
          onPress={() =>
            void run(
              () =>
                updatePage({
                  pageId: page._id,
                  patch: { published: !page.published },
                }),
              { errorTitle: "Couldn't update page" },
            )
          }
        />
      </View>

      <View className="mt-3 flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2">
        <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
          {link}
        </Text>
        <CopyButton text={link} label />
      </View>
      <Text className="mt-1.5 text-xs text-muted">
        {page.published
          ? "Your page is live — share the link far and wide."
          : "Publish to make the link live."}
      </Text>

      <View className="mt-2 flex-row flex-wrap gap-2">
        <Button
          title="Open preview"
          icon="eye"
          variant="secondary"
          size="sm"
          loading={previewLoading}
          onPress={() => void openPreview()}
        />
        {page.published ? (
          <Button
            title="Open page"
            icon="external-link"
            variant="ghost"
            size="sm"
            onPress={() => void Linking.openURL(link)}
          />
        ) : null}
      </View>
      <Text className="mt-1.5 text-xs text-faint">
        Preview works even before you publish — it opens the page with a
        secret link only you can share.
      </Text>

      <View className="mt-3">
        <TextField
          label="Link slug"
          value={slugValue}
          onChangeText={setSlugInput}
          onBlur={() => void saveSlug()}
          onSubmitEditing={() => void saveSlug()}
          autoCapitalize="none"
          autoCorrect={false}
          hint="Lowercase letters, numbers and dashes."
        />
      </View>
    </View>
  );
}
