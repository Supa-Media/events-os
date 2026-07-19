/**
 * Admin "Event page" tab — the whole shareable-event-page control panel, framed
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
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  TextField,
} from "../../ui";
import { ToastView } from "../../ui/Toast";
import { useActionRunner, type ActionRunner } from "../../../lib/useActionToast";
import { formatDateTime } from "../../../lib/format";
import { DesignPhase } from "./DesignPhase";
import { GivingCard } from "./GivingCard";
import { GuestListCard } from "./GuestListCard";
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
import { eventPageUrl, formatMoney } from "./helpers";

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
          message="Create a shareable event page with RSVPs, tickets & a guest feed — one link your whole audience can open."
          action={
            <Button
              title="Create event page"
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
              <GuestListCard eventId={eventId} />
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
          <StatCard label="Going" value={String(page.goingCount)} />
          <StatCard label="Maybe" value={String(page.maybeCount)} />
          <StatCard label="Tickets" value={String(page.ticketsSoldCount)} />
          <StatCard label="Revenue" value={formatMoney(page.revenueCents)} />
          <StatCard label="Given" value={formatMoney(page.donationsCents ?? 0)} />
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

/** One small stat tile in the live "pulse" strip. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="sm" className="min-w-[104px] flex-1">
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text className="mt-1 font-display text-xl text-ink">{value}</Text>
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
  const [slugInput, setSlugInput] = useState<string | null>(null);
  const slugValue = slugInput !== null ? slugInput : page.slug;
  const link = eventPageUrl(page.slug);

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
