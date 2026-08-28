/**
 * MARKETING · Links — the homepage's Important Links grid.
 *
 * The section people actually reach the org through: Donate, the socials,
 * Zelle, and whatever event is next. It was a YAML file in the landing repo, so
 * adding a card, swapping a background image, or moving one above another was a
 * pull request and a deploy. It is rows now, and this is the desk.
 *
 * ── The live-events row ─────────────────────────────────────────────────────
 * The grid's most important row is not a card. It is the placeholder for the
 * event cards the page pulls automatically, and it sits in the SAME ordered
 * list as everything else — so "put the events above Donate" is a move, not a
 * code change. Its controls are the three overrides the team asked for: how
 * many show, which to lead with, and which to keep off the front page even
 * though their RSVP pages are public.
 *
 * The preview under that row is the REAL selection — the same
 * `resolveEventCards` the public feed runs — so what it shows is what the site
 * will show. A preview computed a second way would be a preview that can lie.
 *
 * ── Reordering ──────────────────────────────────────────────────────────────
 * Up/down buttons rather than drag-and-drop. This screen runs on phone, web,
 * and tablet out of one file, and a drag that works on all three is a
 * gesture-handler dependency and a pile of platform branches for a list that is
 * five rows long. Each press sends the whole new order
 * (`reorderLinks`), which cannot leave two cards claiming the same slot.
 */
import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  SITE_LINK_ALIGNS,
  SITE_LINK_CTA_MAX,
  SITE_LINK_COPY_MAX,
  SITE_LINK_MAX_EVENTS_CAP,
  SITE_LINK_SUBTITLE_MAX,
  SITE_LINK_TITLE_MAX,
  SITE_LINK_URL_MAX,
  type SiteLinkAlign,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  CheckboxRow,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  Select,
  SectionHeader,
  TextField,
  ToastView,
} from "../ui";
import { useActionRunner } from "../../lib/useActionToast";

type LinkRow = {
  id: string;
  kind: "link" | "events";
  title: string;
  subtitle: string | null;
  url: string | null;
  thumbnail: string | null;
  bgImage: string | null;
  cta: string | null;
  copy: string | null;
  align: SiteLinkAlign;
  published: boolean;
  order: number;
  maxEvents: number | null;
  pinnedEventSlugs: string[] | null;
  hiddenEventSlugs: string[] | null;
};

const ALIGN_OPTIONS = SITE_LINK_ALIGNS.map((a) => ({
  value: a,
  label: a === "center" ? "Centered" : "Top left",
}));

/** A blank card's fields, so "New card" and "Cancel" both have one shape to
 *  reset to. */
const EMPTY_DRAFT = {
  title: "",
  subtitle: "",
  url: "",
  cta: "",
  copy: "",
  align: "center" as SiteLinkAlign,
  published: false,
};

type Draft = typeof EMPTY_DRAFT;

function draftFrom(row: LinkRow): Draft {
  return {
    title: row.title,
    subtitle: row.subtitle ?? "",
    url: row.url ?? "",
    cta: row.cta ?? "",
    copy: row.copy ?? "",
    align: row.align,
    published: row.published,
  };
}

/** The card editor — used for both an existing card and a new one, because
 *  they are the same fields and a second copy of them is a second place to
 *  forget a bound. */
function CardEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saveLabel,
}: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  // The one rule worth stating in the UI rather than only in the error: a card
  // either goes somewhere or copies something. The Zelle card is the reason —
  // it navigates nowhere on purpose.
  const usable = draft.title.trim() && (draft.url.trim() || draft.copy.trim());
  return (
    <View>
      <TextField
        label="Title"
        value={draft.title}
        onChangeText={(title) => setDraft({ ...draft, title })}
        maxLength={SITE_LINK_TITLE_MAX}
        hint="Shown on the card unless it has a logo image."
      />
      <TextField
        label="Subtitle"
        value={draft.subtitle}
        onChangeText={(subtitle) => setDraft({ ...draft, subtitle })}
        maxLength={SITE_LINK_SUBTITLE_MAX}
      />
      <TextField
        label="Links to"
        value={draft.url}
        onChangeText={(url) => setDraft({ ...draft, url })}
        maxLength={SITE_LINK_URL_MAX}
        autoCapitalize="none"
        hint="A full https:// address, or a path on our own site like /give."
      />
      <TextField
        label="Copies instead"
        value={draft.copy}
        onChangeText={(copy) => setDraft({ ...draft, copy })}
        maxLength={SITE_LINK_COPY_MAX}
        autoCapitalize="none"
        hint="Leave the link blank and put text here to make a tap-to-copy card, like the Zelle one."
      />
      <TextField
        label="Small line"
        value={draft.cta}
        onChangeText={(cta) => setDraft({ ...draft, cta })}
        maxLength={SITE_LINK_CTA_MAX}
        hint="Sits under the subtitle — “(Click to Copy)”."
      />
      <Select
        label="Text position"
        value={draft.align}
        options={ALIGN_OPTIONS}
        onChange={(align) => setDraft({ ...draft, align: align as SiteLinkAlign })}
      />
      <CheckboxRow
        checked={draft.published}
        onPress={() => setDraft({ ...draft, published: !draft.published })}
        label="Show on the site"
      />
      <View className="flex-row items-center gap-2">
        <Button title={saveLabel} size="sm" disabled={!usable} onPress={onSave} />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

/** The live-events row's own controls. Separate from `CardEditor` because it
 *  shares none of its fields — it is a rule, not a card. */
function EventsRowEditor({
  row,
  pinnable,
  preview,
  onSave,
}: {
  row: LinkRow;
  pinnable: { slug: string; title: string; startDate: number }[];
  preview: { slug: string; title: string; pinned: boolean }[];
  onSave: (next: {
    maxEvents: number;
    pinnedEventSlugs: string[];
    hiddenEventSlugs: string[];
  }) => void;
}) {
  const [max, setMax] = useState(String(row.maxEvents ?? 0));
  const [pinned, setPinned] = useState<string[]>(row.pinnedEventSlugs ?? []);
  const [hidden, setHidden] = useState<string[]>(row.hiddenEventSlugs ?? []);
  useEffect(() => {
    setMax(String(row.maxEvents ?? 0));
    setPinned(row.pinnedEventSlugs ?? []);
    setHidden(row.hiddenEventSlugs ?? []);
  }, [row.maxEvents, row.pinnedEventSlugs, row.hiddenEventSlugs]);

  const dirty =
    Number(max) !== (row.maxEvents ?? 0) ||
    pinned.join("|") !== (row.pinnedEventSlugs ?? []).join("|") ||
    hidden.join("|") !== (row.hiddenEventSlugs ?? []).join("|");

  /** Pin and hide are mutually exclusive on one event: hide wins in the
   *  resolver, so letting both be ticked here would show a state the site
   *  ignores. Ticking one unticks the other. */
  function togglePin(slug: string) {
    setPinned((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    setHidden((prev) => prev.filter((s) => s !== slug));
  }
  function toggleHide(slug: string) {
    setHidden((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    setPinned((prev) => prev.filter((s) => s !== slug));
  }

  const countOptions = Array.from(
    { length: SITE_LINK_MAX_EVENTS_CAP + 1 },
    (_, n) => ({
      value: String(n),
      label: n === 0 ? "None" : `${n} card${n === 1 ? "" : "s"}`,
    }),
  );

  return (
    <View>
      <Select
        label="How many event cards"
        value={max}
        options={countOptions}
        onChange={setMax}
        hint="Soonest first, unless you lead with one below. They drop off on their own the day after the event."
      />

      {pinnable.length === 0 ? (
        <Text className="mb-3 text-xs text-muted">
          No published event pages right now — publish one from its event and it
          shows up here.
        </Text>
      ) : (
        <View className="mb-3">
          <Text className="mb-1.5 text-sm font-semibold text-ink">
            Published event pages
          </Text>
          <Text className="mb-2 text-xs text-muted">
            Lead with an event to put it first even if it isn't the next one.
            Hide one to keep it off the homepage entirely.
          </Text>
          {pinnable.map((ev) => (
            <View
              key={ev.slug}
              className="mb-2 flex-row items-center justify-between gap-3"
            >
              <View className="flex-1">
                <Text className="text-sm text-ink" numberOfLines={1}>
                  {ev.title}
                </Text>
                <Text className="text-xs text-faint">
                  {new Date(ev.startDate).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  · /rsvp/{ev.slug}
                </Text>
              </View>
              <Pressable onPress={() => togglePin(ev.slug)}>
                <Badge
                  label="Lead with"
                  tone={pinned.includes(ev.slug) ? "accent" : "neutral"}
                />
              </Pressable>
              <Pressable onPress={() => toggleHide(ev.slug)}>
                <Badge
                  label="Hide"
                  tone={hidden.includes(ev.slug) ? "warn" : "neutral"}
                />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View className="mb-3 rounded-md border border-border bg-surface p-3">
        <Text className="mb-1 text-xs font-semibold text-ink">
          On the site right now
        </Text>
        {preview.length === 0 ? (
          <Text className="text-xs text-muted">
            No event cards. {Number(max) === 0
              ? "Set a count above to show some."
              : "Nothing published is coming up."}
          </Text>
        ) : (
          preview.map((ev) => (
            <Text key={ev.slug} className="text-xs text-muted">
              • {ev.title}
              {ev.pinned ? " (leading)" : ""}
            </Text>
          ))
        )}
      </View>

      <View className="flex-row">
        <Button
          title="Save"
          size="sm"
          disabled={!dirty}
          onPress={() =>
            onSave({
              maxEvents: Number(max),
              pinnedEventSlugs: pinned,
              hiddenEventSlugs: hidden,
            })
          }
        />
      </View>
    </View>
  );
}

export function MarketingLinksView() {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const canEdit = access?.canEditSite === true;
  const content = useQuery(api.marketingSite.siteContent, canEdit ? {} : "skip");
  const pinnable = useQuery(api.marketingSite.pinnableEvents, canEdit ? {} : "skip");

  const upsertLink = useMutation(api.marketingSite.upsertLink);
  const deleteLink = useMutation(api.marketingSite.deleteLink);
  const reorderLinks = useMutation(api.marketingSite.reorderLinks);
  const setLinkPublished = useMutation(api.marketingSite.setLinkPublished);
  const setEventsRow = useMutation(api.marketingSite.setEventsRow);

  const { run, toast, dismiss } = useActionRunner();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY_DRAFT);

  if (access === undefined) return <Screen loading />;
  if (!canEdit) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Site access needed"
            message="Editing the public site is the Marketing Director's desk. Ask them or the ED for access."
          />
        </Narrow>
      </Screen>
    );
  }
  if (content === undefined) return <Screen loading />;

  const rows = content.links as LinkRow[];

  /** Move one row up or down by sending the WHOLE new order — see the module
   *  doc for why a delta would be the fragile version of this. */
  function move(index: number, delta: number) {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void run(
      () =>
        reorderLinks({ linkIds: next.map((r) => r.id as Id<"siteLinks">) }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  function saveCard(linkId: string | null, d: Draft) {
    void run(
      () =>
        upsertLink({
          ...(linkId ? { linkId: linkId as Id<"siteLinks"> } : {}),
          title: d.title,
          ...(d.subtitle ? { subtitle: d.subtitle } : {}),
          ...(d.url ? { url: d.url } : {}),
          ...(d.cta ? { cta: d.cta } : {}),
          ...(d.copy ? { copy: d.copy } : {}),
          align: d.align,
          published: d.published,
        }),
      {
        errorTitle: "Couldn't save that card",
        onSuccess: () => {
          setEditingId(null);
          setCreating(false);
          setNewDraft(EMPTY_DRAFT);
        },
      },
    );
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader
          title="Important Links"
          count={`${rows.length} row${rows.length === 1 ? "" : "s"}`}
        />
        <Text className="mb-4 text-sm text-muted">
          The grid on publicworship.life, in this order. Changes are live within
          about a minute. A card stays off the site until “Show on the site” is
          ticked.
        </Text>

        {rows.length === 0 ? (
          <EmptyState
            title="No cards yet"
            message="Run the one-time seed to bring across the cards the site shipped with, or add one below."
          />
        ) : null}

        {rows.map((row, index) => {
          const isEditing = editingId === row.id;
          return (
            <Card key={row.id} padding="md" className="mb-3">
              <View className="mb-2 flex-row items-center gap-2">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {row.kind === "events" ? "Live event cards" : row.title}
                  </Text>
                  <Text className="text-xs text-faint" numberOfLines={1}>
                    {row.kind === "events"
                      ? `Chosen automatically · showing ${row.maxEvents ?? 0}`
                      : (row.url ?? (row.copy ? `Copies “${row.copy}”` : "No link"))}
                  </Text>
                </View>
                <Badge
                  label={row.published ? "Live" : "Hidden"}
                  tone={row.published ? "success" : "warn"}
                />
                <Pressable
                  onPress={() => move(index, -1)}
                  disabled={index === 0}
                  accessibilityLabel="Move up"
                >
                  <Icon name="chevron-up" size={18} />
                </Pressable>
                <Pressable
                  onPress={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                  accessibilityLabel="Move down"
                >
                  <Icon name="chevron-down" size={18} />
                </Pressable>
              </View>

              {row.kind === "events" ? (
                <EventsRowEditor
                  row={row}
                  pinnable={pinnable ?? []}
                  preview={content.eventPreview}
                  onSave={(next) =>
                    void run(() => setEventsRow(next), {
                      errorTitle: "Couldn't save the events row",
                    })
                  }
                />
              ) : isEditing ? (
                <CardEditor
                  draft={draft}
                  setDraft={setDraft}
                  saveLabel="Save"
                  onSave={() => saveCard(row.id, draft)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <View className="flex-row items-center gap-2">
                  <Button
                    title="Edit"
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      setDraft(draftFrom(row));
                      setEditingId(row.id);
                    }}
                  />
                  <Button
                    title={row.published ? "Hide" : "Show"}
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      void run(
                        () =>
                          setLinkPublished({
                            linkId: row.id as Id<"siteLinks">,
                            published: !row.published,
                          }),
                        { errorTitle: "Couldn't change that" },
                      )
                    }
                  />
                  <Button
                    title="Delete"
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      void run(
                        () => deleteLink({ linkId: row.id as Id<"siteLinks"> }),
                        { errorTitle: "Couldn't delete that card" },
                      )
                    }
                  />
                </View>
              )}
            </Card>
          );
        })}

        {creating ? (
          <Card padding="md" className="mb-6">
            <Text className="mb-3 text-sm font-semibold text-ink">New card</Text>
            <CardEditor
              draft={newDraft}
              setDraft={setNewDraft}
              saveLabel="Add card"
              onSave={() => saveCard(null, newDraft)}
              onCancel={() => {
                setCreating(false);
                setNewDraft(EMPTY_DRAFT);
              }}
            />
          </Card>
        ) : (
          <View className="mb-6 flex-row">
            <Button
              title="New card"
              icon="plus"
              size="sm"
              variant="secondary"
              onPress={() => setCreating(true)}
            />
          </View>
        )}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
