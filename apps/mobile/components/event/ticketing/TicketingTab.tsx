/**
 * Admin "Tickets" tab — the whole shareable-event-page control panel: page
 * setup, publish + share link, ticket tiers, live stats, guest list, door
 * check-in, and blasts. Rendered by event/[id].tsx when the tab is active.
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
  SectionHeader,
  TextField,
} from "../../ui";
import { ToastView } from "../../ui/Toast";
import { useActionRunner, type ActionRunner } from "../../../lib/useActionToast";
import { PageSetupCard } from "./PageSetupCard";
import { TicketTypesCard } from "./TicketTypesCard";
import { GuestListCard } from "./GuestListCard";
import { CheckInCard } from "./CheckInCard";
import { BlastComposerCard } from "./BlastComposerCard";
import { formatMoney, publicSiteUrl } from "./helpers";

export default function TicketingTab({ eventId }: { eventId: Id<"events"> }) {
  const { run, toast, dismiss } = useActionRunner();
  const data = useQuery(api.ticketing.getAdminPage, { eventId });
  const createPage = useMutation(api.ticketing.createPage);
  const [creating, setCreating] = useState(false);

  if (data === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading tickets…</Text>
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

  return (
    <View>
      <ToastView toast={toast} onDismiss={dismiss} />

      <SectionHeader title="Page setup" />
      <PageSetupCard page={page} coverUrl={coverUrl} run={run} />

      <SectionHeader title="Publish & share" />
      <PublishShareCard page={page} run={run} />

      <SectionHeader title="Tickets" count={ticketTypes.length} />
      <TicketTypesCard
        eventId={eventId}
        page={page}
        ticketTypes={ticketTypes}
        run={run}
      />

      <SectionHeader title="At a glance" />
      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Going" value={String(page.goingCount)} />
        <StatCard label="Maybe" value={String(page.maybeCount)} />
        <StatCard label="Tickets sold" value={String(page.ticketsSoldCount)} />
        <StatCard label="Revenue" value={formatMoney(page.revenueCents)} />
      </View>

      <SectionHeader title="Guest list" />
      <GuestListCard eventId={eventId} />

      <SectionHeader title="Check-in" />
      <CheckInCard eventId={eventId} run={run} />

      <SectionHeader title="Blasts" />
      <BlastComposerCard eventId={eventId} run={run} />
    </View>
  );
}

/** One small stat tile in the "At a glance" strip. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="sm" className="min-w-[110px] flex-1">
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
  const link = `${publicSiteUrl()}/e/${page.slug}`;

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
    <Card>
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
      {!page.published ? (
        <Text className="mt-1.5 text-xs text-muted">
          Publish to make the link live.
        </Text>
      ) : null}

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
    </Card>
  );
}
