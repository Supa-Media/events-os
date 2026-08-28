/**
 * MARKETING · Links — the homepage's Important Links grid.
 *
 * The section people actually reach the org through: Donate, the socials,
 * Zelle, and whatever event is next. It was a YAML file in the landing repo, so
 * adding a card, swapping a background image, or moving one above another was a
 * pull request and a deploy. It is rows now, and this is the desk.
 *
 * ── The screen is a MIRROR, not a table ─────────────────────────────────────
 * The founder's read of the first cut: "the links and the site stuff just
 * doesn't work… I wanna see the things that already appear in that section
 * kinda show up here." The rows were correct and the screen still failed,
 * because a row of title-plus-URL text is not something you can hold up next to
 * publicworship.life and check. So every row leads with the TILE it produces
 * (`LinkCardTile`, a small copy of `LinkCard.astro`'s rule), the live event
 * cards are drawn as the cards they are rather than counted, and a card that is
 * off the page says so in words as well as with a badge.
 *
 * ── The live-events row ─────────────────────────────────────────────────────
 * The grid's most important row is not a card. It is the placeholder for the
 * event cards the page pulls automatically, and it sits in the SAME ordered
 * list as everything else — so "put the events above Donate" is a move, not a
 * code change. Its controls are the three overrides the team asked for: how
 * many show, which to lead with, and which to keep off the front page even
 * though their RSVP pages are public.
 *
 * Those controls now live behind the row's own Edit, like a card's fields do,
 * and what sits in the row itself is the REAL selection — `content.eventPreview`,
 * the same `resolveEventCards` the public feed runs. A preview computed a
 * second way would be a preview that can lie, and a permanently-expanded rule
 * editor in the middle of the list was the thing that stopped the list reading
 * as the page.
 *
 * ── Where the card form went ────────────────────────────────────────────────
 * The card's fields, its draft shape, and the three-state image rule other
 * screens cite as "LinksView's `EMPTY_DRAFT`" now live in `LinkCardForm.tsx` —
 * they moved out when the form became progressive rather than a wall of
 * inputs, and the rule is unchanged. `BlogPostEditor` and `DesignsView` point
 * at it from here.
 *
 * ── Reordering ──────────────────────────────────────────────────────────────
 * Up/down buttons rather than drag-and-drop. This screen runs on phone, web,
 * and tablet out of one file, and a drag that works on all three is a
 * gesture-handler dependency and a pile of platform branches for a list that is
 * five rows long. Each press sends the whole new order
 * (`reorderLinks`), which cannot leave two cards claiming the same slot.
 */
import { useEffect, useState } from "react";
import { View, Text, Linking, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { SITE_LINK_MAX_EVENTS_CAP } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  Select,
  SectionHeader,
  ToastView,
} from "../ui";
import { useActionRunner } from "../../lib/useActionToast";
import { LinkCardTile, type LinkRow } from "./LinkCardTile";
import {
  cardFieldsFrom,
  draftFrom,
  EMPTY_DRAFT,
  LinkCardForm,
  type LinkDraft,
} from "./LinkCardForm";

/** The grid, on the site people actually visit. Hard-coded to the branded
 *  domain (as `MailingListView` does) rather than `publicSiteUrl()`: this is a
 *  link to the LANDING page, which is a different thing from the Convex host
 *  that serves `/rsvp` and `/api` everywhere but prod. */
const PUBLIC_LINKS_URL = "https://publicworship.life/#links";

/**
 * One row of `marketingSite.pinnableEvents`.
 *
 * The two flags are typed OPTIONAL on purpose. That query is being widened in
 * the same push as this screen — from "upcoming only" to "everything a
 * marketer might be looking for", which is why it needs to say which rows are
 * still upcoming and which are on the page right now — and a screen that only
 * compiles against the new shape would have to ship after the backend rather
 * than with it. Both have a defensible answer without the server: everything is
 * upcoming (what the old query returned), and "on the page" is derivable from
 * `eventPreview`, which this screen already holds.
 */
type PinnableEvent = {
  slug: string;
  title: string;
  startDate: number;
  venueName: string | null;
  isUpcoming?: boolean;
  onPageNow?: boolean;
};

/** The subset of a live event card this screen draws. Structural rather than
 *  `PublicSiteEventCard` so the strip states what it actually reads. */
type LiveEventCard = {
  slug: string;
  title: string;
  startDate: number;
  coverUrl: string | null;
  pinned: boolean;
};

/** "Sat, Aug 30" — the same shape the site prints under an event card
 *  (`siteContent.ts#formatEventDate`), so the desk and the page agree. */
function formatEventDay(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * The event cards that are on the page right now, drawn as cards.
 *
 * `eventPreview` is resolved with the row forced published (see
 * `marketingSite.siteContent`), so it answers "what would this row show" rather
 * than "what does it show" — which is the right thing to keep visible while the
 * row is hidden, and the reason the hidden case dims the tiles and says so
 * instead of rendering nothing.
 */
function LiveEventStrip({
  cards,
  maxEvents,
  published,
}: {
  cards: LiveEventCard[];
  maxEvents: number;
  published: boolean;
}) {
  if (cards.length === 0) {
    return (
      <Text className="mt-2 text-xs text-muted">
        {maxEvents === 0
          ? "Set to none — the page shows no event cards here."
          : "Nothing published is coming up, so the page shows no event cards here."}
      </Text>
    );
  }
  return (
    <View className="mt-2">
      <Text className="mb-1.5 text-xs text-muted">
        {published
          ? "On the page right now:"
          : "Hidden — none of these are on the page right now:"}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {cards.map((ev) => (
          <View key={ev.slug} className="w-[92px]">
            <LinkCardTile
              title={ev.title}
              subtitle={formatEventDay(ev.startDate)}
              bgImage={ev.coverUrl}
              dimmed={!published}
            />
            <Text className="mt-1 text-2xs text-ink" numberOfLines={1}>
              {ev.title}
            </Text>
            <Text className="text-2xs text-faint" numberOfLines={1}>
              {formatEventDay(ev.startDate)}
              {ev.pinned ? " · leading" : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The live-events row's own controls. Separate from `LinkCardForm` because it
 *  shares none of its fields — it is a rule, not a card. */
function EventsRowEditor({
  row,
  pinnable,
  onSave,
  onCancel,
}: {
  row: LinkRow;
  pinnable: PinnableEvent[];
  onSave: (next: {
    maxEvents: number;
    pinnedEventSlugs: string[];
    hiddenEventSlugs: string[];
  }) => void;
  onCancel: () => void;
}) {
  // SEEDED ONCE, never re-synced from the query.
  //
  // The obvious version — an effect that copies `row` into state whenever it
  // changes — silently threw away unsaved work. `pinnedEventSlugs` and
  // `hiddenEventSlugs` are fresh array identities on every `siteContent`
  // result, so ANY unrelated change to `siteLinks` (someone renaming a card,
  // this desk's own reorder, a second tab) re-ran it and reset the pins the
  // marketer was in the middle of setting. The editor is short-lived and opens
  // from a button, so seeding at mount is enough; the cost — a concurrent edit
  // to this one row is not pulled in — is smaller than losing the edit in
  // progress, and closing and reopening picks it up.
  const [max, setMax] = useState(String(row.maxEvents ?? 0));
  const [pinned, setPinned] = useState<string[]>(row.pinnedEventSlugs ?? []);
  const [hidden, setHidden] = useState<string[]>(row.hiddenEventSlugs ?? []);

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

  // Split rather than filtered: a page that has already happened cannot be
  // pinned back onto the grid (a pin only reorders what is publishable —
  // `resolveEventCards`), so offering it the same two toggles would be offering
  // a control that does nothing. It is still worth LISTING, because "where did
  // last Saturday's card go?" is the question the list is being read to answer.
  const upcoming = pinnable.filter((e) => e.isUpcoming ?? true);
  const finished = pinnable.filter((e) => !(e.isUpcoming ?? true));

  return (
    <View className="mt-3 border-t border-border pt-3">
      <Select
        label="How many event cards"
        value={max}
        options={countOptions}
        onChange={setMax}
        hint="Soonest first, unless you lead with one below. They drop off on their own the day after the event."
      />

      {upcoming.length === 0 ? (
        <Text className="mb-3 text-xs text-muted">
          No published event pages coming up — publish one from its event and it
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
          {upcoming.map((ev) => (
            <View
              key={ev.slug}
              className="mb-2 flex-row items-center justify-between gap-2"
            >
              <View className="flex-1">
                <Text className="text-sm text-ink" numberOfLines={1}>
                  {ev.title}
                </Text>
                <Text className="text-xs text-faint" numberOfLines={1}>
                  {formatEventDay(ev.startDate)}
                  {ev.venueName ? ` · ${ev.venueName}` : ""} · /rsvp/{ev.slug}
                </Text>
              </View>
              {ev.onPageNow ? <Badge label="On the page" tone="success" /> : null}
              <Pressable
                onPress={() => togglePin(ev.slug)}
                accessibilityRole="button"
              >
                <Badge
                  label="Lead with"
                  tone={pinned.includes(ev.slug) ? "accent" : "neutral"}
                />
              </Pressable>
              <Pressable
                onPress={() => toggleHide(ev.slug)}
                accessibilityRole="button"
              >
                <Badge
                  label="Hide"
                  tone={hidden.includes(ev.slug) ? "warn" : "neutral"}
                />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {finished.length > 0 ? (
        <View className="mb-3">
          <Text className="mb-1.5 text-sm font-semibold text-ink">
            Recently finished
          </Text>
          <Text className="mb-2 text-xs text-muted">
            These drop off the grid on their own, the day after the event —
            there is nothing to set. A leftover setting can still be cleared.
          </Text>
          {finished.map((ev) => {
            // A finished event can still CARRY a pin or a hide set while it was
            // upcoming. Offering Lead-with/Hide here would be offering controls
            // that do nothing (`resolveEventCards` drops it either way), but
            // leaving it as plain text was the gap that reaching back for these
            // rows was meant to close: the setting would be stuck forever,
            // invisible, and would fire again if the event were ever
            // rescheduled. So the only affordance is the one that has an
            // effect — taking it off.
            const stale = pinned.includes(ev.slug)
              ? "Leading"
              : hidden.includes(ev.slug)
                ? "Hidden"
                : null;
            return (
              <View
                key={ev.slug}
                className="mb-1.5 flex-row items-center justify-between gap-2"
              >
                <Text className="flex-1 text-xs text-faint" numberOfLines={1}>
                  {ev.title} · {formatEventDay(ev.startDate)}
                </Text>
                {stale ? (
                  <>
                    <Badge label={stale} tone="neutral" />
                    <Button
                      title="Clear"
                      size="sm"
                      variant="ghost"
                      onPress={() => {
                        setPinned((prev) => prev.filter((sl) => sl !== ev.slug));
                        setHidden((prev) => prev.filter((sl) => sl !== ev.slug));
                      }}
                    />
                  </>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      <View className="flex-row items-center gap-2">
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
        <Button title="Done" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

export function MarketingLinksView() {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const canEdit = access?.canEditSite === true;
  const content = useQuery(api.marketingSite.siteContent, canEdit ? {} : "skip");
  // Cast to the tolerant shape — see `PinnableEvent` for why the two flags are
  // read as optional rather than required.
  const pinnable = useQuery(
    api.marketingSite.pinnableEvents,
    canEdit ? {} : "skip",
  ) as PinnableEvent[] | undefined;

  const upsertLink = useMutation(api.marketingSite.upsertLink);
  const deleteLink = useMutation(api.marketingSite.deleteLink);
  const reorderLinks = useMutation(api.marketingSite.reorderLinks);
  const setLinkPublished = useMutation(api.marketingSite.setLinkPublished);
  const setEventsRow = useMutation(api.marketingSite.setEventsRow);

  const { run, toast, dismiss } = useActionRunner();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LinkDraft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<LinkDraft>(EMPTY_DRAFT);

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
  const liveCards = content.eventPreview as LiveEventCard[];

  /** Fill in `onPageNow` when the server has not started sending it — the
   *  preview IS the page's selection, so this is the same answer, derived. */
  const previewSlugs = new Set(liveCards.map((e) => e.slug));
  const pinnableRows: PinnableEvent[] = (pinnable ?? []).map((e) => ({
    ...e,
    onPageNow: e.onPageNow ?? previewSlugs.has(e.slug),
  }));

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

  function saveCard(linkId: string | null, d: LinkDraft) {
    void run(
      () =>
        upsertLink({
          ...(linkId ? { linkId: linkId as Id<"siteLinks"> } : {}),
          ...cardFieldsFrom(d),
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
        <Text className="mb-2 text-sm text-muted">
          What the grid on publicworship.life shows, in this order — each row is
          the tile it draws. Changes are live within about a minute.
        </Text>
        <View className="mb-4 flex-row">
          <Button
            title="Open the page"
            icon="external-link"
            size="sm"
            variant="ghost"
            onPress={() => void Linking.openURL(PUBLIC_LINKS_URL)}
          />
        </View>

        {rows.length === 0 ? (
          <EmptyState
            title="No cards yet"
            message="The cards the site shipped with (Donate, the socials, Zelle) arrive with the next deploy. Add one here in the meantime."
          />
        ) : null}

        {rows.map((row, index) => {
          const isEvents = row.kind === "events";
          const isEditing = editingId === row.id;
          // While a card is being edited its tile follows the DRAFT, so
          // "centered or top left?" and "does the subtitle fit?" are answered by
          // looking at the tile instead of by saving and checking the site.
          // Images are the exception the draft cannot preview: an upload has no
          // public URL until the card is saved (see `CardImagePicker`), so the
          // tile shows the saved image unless the draft has cleared it.
          const preview = isEditing && !isEvents ? draft : null;
          // What the card does, in the words the site would use. The events row
          // has no destination of its own — the cards it draws carry theirs.
          const destination = isEvents
            ? `Chosen automatically · up to ${row.maxEvents ?? 0}`
            : (row.url ?? (row.copy ? `Copies “${row.copy}”` : "No link"));
          return (
            <Card key={row.id} padding="md" className="mb-3">
              <View className="flex-row gap-3">
                {isEvents ? (
                  // The events row draws no tile of its own; the strip below is
                  // its likeness. A calendar chip keeps the row's left edge
                  // aligned with the cards' tiles instead of ragged.
                  <View className="h-[62px] w-[92px] items-center justify-center rounded-md border border-border bg-sunken">
                    <Icon name="calendar" size={18} />
                  </View>
                ) : (
                  <LinkCardTile
                    title={preview ? preview.title : row.title}
                    subtitle={preview ? preview.subtitle : row.subtitle}
                    thumbnail={preview?.thumbnailCleared ? null : row.thumbnail}
                    bgImage={preview?.bgCleared ? null : row.bgImage}
                    align={preview ? preview.align : row.align}
                    dimmed={!(preview ? preview.published : row.published)}
                  />
                )}
                <View className="flex-1">
                  <View className="flex-row items-start gap-2">
                    <View className="flex-1">
                      <Text
                        className="text-sm font-semibold text-ink"
                        numberOfLines={1}
                      >
                        {isEvents ? "Live event cards" : row.title}
                      </Text>
                      <Text className="text-xs text-faint" numberOfLines={1}>
                        {destination}
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
                  {/* The badge says "Hidden"; this says what that MEANS, which
                      is the half a marketer looking for a missing card needs. */}
                  {!row.published && !isEvents ? (
                    <Text className="mt-1 text-xs text-warn">
                      Not on publicworship.life — press Show to put it up.
                    </Text>
                  ) : null}
                </View>
              </View>

              {isEvents ? (
                <LiveEventStrip
                  cards={liveCards}
                  maxEvents={row.maxEvents ?? 0}
                  published={row.published}
                />
              ) : null}

              {isEditing && !isEvents ? (
                <View className="mt-3 border-t border-border pt-3">
                  <LinkCardForm
                    draft={draft}
                    setDraft={setDraft}
                    saveLabel="Save"
                    row={row}
                    run={run}
                    onSave={() => saveCard(row.id, draft)}
                    onCancel={() => setEditingId(null)}
                  />
                </View>
              ) : isEditing && isEvents ? (
                <EventsRowEditor
                  row={row}
                  pinnable={pinnableRows}
                  onCancel={() => setEditingId(null)}
                  onSave={(next) =>
                    void run(() => setEventsRow(next), {
                      errorTitle: "Couldn't save the events row",
                      // Close on success so the strip above — which is now the
                      // answer to "did that do what I wanted?" — is what the
                      // marketer is looking at when the save lands.
                      onSuccess: () => setEditingId(null),
                    })
                  }
                />
              ) : (
                <View className="mt-2 flex-row items-center gap-2">
                  <Button
                    title="Edit"
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      if (!isEvents) setDraft(draftFrom(row));
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
                  {/* The events row is not deletable — deleting it would not
                      take the events off the page, it would take away the only
                      handle on where they land. Hiding is what it has. */}
                  {isEvents ? null : (
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
                  )}
                </View>
              )}
            </Card>
          );
        })}

        {creating ? (
          <Card padding="md" className="mb-6">
            <Text className="mb-3 text-sm font-semibold text-ink">New card</Text>
            <LinkCardForm
              draft={newDraft}
              setDraft={setNewDraft}
              saveLabel="Add card"
              run={run}
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
