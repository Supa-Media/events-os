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
 * ── The two automatic rows ──────────────────────────────────────────────────
 * The grid's most important rows are not cards. They are the placeholders for
 * the cards the page pulls by itself — the live events, and now the latest blog
 * posts — and they sit in the SAME ordered list as everything else, so "put the
 * events above Donate" is a move, not a code change. Each carries the same
 * three overrides the team asked for: how many show, which to lead with, and
 * which to keep off the front page even though the page behind it is public.
 *
 * Those controls live behind the row's own Edit, like a card's fields do
 * (`LinksAutoRows.tsx` — both rows together, because they are siblings), and
 * what sits in the row itself is the REAL selection — `content.eventPreview`
 * and `content.postPreview`, the same resolvers the public feed runs. A preview
 * computed a second way would be a preview that can lie, and a
 * permanently-expanded rule editor in the middle of the list was the thing that
 * stopped the list reading as the page.
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
import { useState } from "react";
import { View, Text, Linking, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
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
import {
  AutoRowChip,
  EventsRowEditor,
  LiveEventStrip,
  LivePostStrip,
  PostsRowEditor,
  type LiveEventCard,
  type LivePostCard,
  type PinnableEvent,
  type PinnablePost,
} from "./LinksAutoRows";

/** The grid, on the site people actually visit. Hard-coded to the branded
 *  domain (as `MailingListView` does) rather than `publicSiteUrl()`: this is a
 *  link to the LANDING page, which is a different thing from the Convex host
 *  that serves `/rsvp` and `/api` everywhere but prod. */
const PUBLIC_LINKS_URL = "https://publicworship.life/#links";

export function MarketingLinksView() {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const canEdit = access?.canEditSite === true;
  const content = useQuery(api.marketingSite.siteContent, canEdit ? {} : "skip");
  // Cast to the tolerant shape — see `PinnableEvent` for why its two flags are
  // read as optional rather than required. `pinnablePosts` needs no such cast:
  // that query shipped with both of its flags, so its own type is the truth.
  const pinnable = useQuery(
    api.marketingSite.pinnableEvents,
    canEdit ? {} : "skip",
  ) as PinnableEvent[] | undefined;
  const pinnablePosts: PinnablePost[] | undefined = useQuery(
    api.marketingSite.pinnablePosts,
    canEdit ? {} : "skip",
  );

  const upsertLink = useMutation(api.marketingSite.upsertLink);
  const deleteLink = useMutation(api.marketingSite.deleteLink);
  const reorderLinks = useMutation(api.marketingSite.reorderLinks);
  const setLinkPublished = useMutation(api.marketingSite.setLinkPublished);
  const setEventsRow = useMutation(api.marketingSite.setEventsRow);
  const setPostsRow = useMutation(api.marketingSite.setPostsRow);

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
  const livePosts: LivePostCard[] = content.postPreview;

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
          const isPosts = row.kind === "posts";
          // The two automatic rows answer to the same rules: no tile of their
          // own, no destination of their own, no Delete. Where only one of them
          // is meant, it is named.
          const isAuto = isEvents || isPosts;
          const isEditing = editingId === row.id;
          // While a card is being edited its tile follows the DRAFT, so
          // "centered or top left?" and "does the subtitle fit?" are answered by
          // looking at the tile instead of by saving and checking the site.
          // Images are the exception the draft cannot preview: an upload has no
          // public URL until the card is saved (see `CardImagePicker`), so the
          // tile shows the saved image unless the draft has cleared it.
          const preview = isEditing && !isAuto ? draft : null;
          // What the card does, in the words the site would use. An automatic
          // row has no destination of its own — the cards it draws carry theirs.
          const destination = isEvents
            ? `Chosen automatically · up to ${row.maxEvents ?? 0}`
            : isPosts
              ? `Chosen automatically · up to ${row.maxPosts ?? 0}`
              : (row.url ?? (row.copy ? `Copies “${row.copy}”` : "No link"));
          return (
            <Card key={row.id} padding="md" className="mb-3">
              <View className="flex-row gap-3">
                {isAuto ? (
                  <AutoRowChip icon={isEvents ? "calendar" : "file-text"} />
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
                        {isEvents
                          ? "Live event cards"
                          : isPosts
                            ? "Latest blog posts"
                            : row.title}
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
                  {!row.published && !isAuto ? (
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
              ) : isPosts ? (
                <LivePostStrip
                  cards={livePosts}
                  maxPosts={row.maxPosts ?? 0}
                  published={row.published}
                />
              ) : null}

              {isEditing && !isAuto ? (
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
              ) : isEditing && isPosts ? (
                <PostsRowEditor
                  row={row}
                  pinnable={pinnablePosts ?? []}
                  onCancel={() => setEditingId(null)}
                  onSave={(next) =>
                    void run(() => setPostsRow(next), {
                      errorTitle: "Couldn't save the posts row",
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
                      if (!isAuto) setDraft(draftFrom(row));
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
                  {/* Neither automatic row is deletable — deleting one would
                      not take its cards off the page, it would take away the
                      only handle on where they land. Hiding is what they
                      have. */}
                  {isAuto ? null : (
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
