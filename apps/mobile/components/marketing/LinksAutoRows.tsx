/**
 * The Important Links grid's two AUTOMATIC rows, and only those.
 *
 * Every other row in the grid is a card somebody typed. These two are rules:
 * `kind: "events"` stands in for the live event cards, `kind: "posts"` for the
 * latest blog posts. They sit in the same ordered list as the fixed cards — so
 * "put the events above Donate" stays a move rather than a code change — and
 * each carries the same three overrides: how many show, which to lead with, and
 * which to keep off the front page even though the page behind it is public.
 *
 * They live together, in one file, because they are siblings and the mirroring
 * is the point: a change to how a marketer leads with an event should be
 * obviously missing from posts if it is not made there too. `LinksView.tsx`
 * keeps the list, the reordering and the card form; this is the rules.
 *
 * ── The preview is the SERVER's answer ──────────────────────────────────────
 * Both strips draw `siteContent`'s own preview (`eventPreview` / `postPreview`),
 * which is the same resolver the public feed runs. A preview computed a second
 * way here would be a preview that can lie, and the whole reason the strips
 * exist is that the founder wanted to see "the things that already appear in
 * that section" on the desk instead of holding the app up next to the site.
 *
 * ── Where the two deliberately differ ───────────────────────────────────────
 * The posts picker sits behind a disclosure and the events picker does not.
 * That is not drift: an event list is short and self-clearing (a finished event
 * drops off on its own), while the blog only ever grows, so an always-open list
 * of every published post is the tall form the founder already asked us to stop
 * building ("it's so big, so many fields… it could be clear what's optional").
 * The disclosure opens by itself when the row already leads with or hides
 * something, on `LinkCardForm`'s rule — never collapse a control with content
 * in it.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  SITE_LINK_MAX_EVENTS_CAP,
  SITE_LINK_MAX_POSTS_CAP,
  type SiteLinkAlign,
} from "@events-os/shared";
import { Badge, Button, Icon, Select } from "../ui";
import { colors } from "../../lib/theme";
import { LinkCardTile, type LinkRow } from "./LinkCardTile";

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
 * `eventPreview`, which the screen already holds.
 */
export type PinnableEvent = {
  slug: string;
  title: string;
  startDate: number;
  venueName: string | null;
  isUpcoming?: boolean;
  onPageNow?: boolean;
};

/**
 * One row of `marketingSite.pinnablePosts` — the posts a marketer can lead with
 * or keep off.
 *
 * Both flags are REQUIRED, unlike `PinnableEvent`'s, because that query shipped
 * with them: `isPublished` false is a post that has been taken down (still
 * listed, so a setting left on it can be cleared — see `PostsRowEditor`), and
 * `onPageNow` is the server's own answer to "is this on the homepage at this
 * moment", resolved by the same code the public feed runs.
 */
export type PinnablePost = {
  slug: string;
  title: string;
  /** When it went live. Null for a post that never did. */
  publishedAt: number | null;
  isPublished: boolean;
  onPageNow: boolean;
};

/** The subset of a live event card this screen draws. Structural rather than
 *  `PublicSiteEventCard` so the strip states what it actually reads. */
export type LiveEventCard = {
  slug: string;
  title: string;
  startDate: number;
  coverUrl: string | null;
  pinned: boolean;
};

/** Likewise for a post card — `PublicSitePostCard`'s drawable half. */
export type LivePostCard = {
  slug: string;
  title: string;
  publishedAt: number;
  coverUrl: string | null;
  pinned: boolean;
};

/** "Sat, Aug 30" — the same shape the site prints under an event card
 *  (`siteContent.ts#formatEventDate`), so the desk and the page agree. */
export function formatEventDay(ms: number): string {
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

/** "Aug 30, 2026" — a post is dated, not scheduled, so it prints the year the
 *  way the Blog tab does and drops the weekday nobody needs. */
export function formatPostDay(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** The chip that stands in for an auto row's tile, so the row's left edge lines
 *  up with the cards' tiles instead of going ragged. The row draws no tile of
 *  its own — the strip underneath is its likeness. */
export function AutoRowChip({ icon }: { icon: "calendar" | "file-text" }) {
  return (
    <View className="h-[62px] w-[92px] items-center justify-center rounded-md border border-border bg-sunken">
      <Icon name={icon} size={18} />
    </View>
  );
}

/** One strip of tiles, with the line above that says what they are. Shared by
 *  both rows because "what is on the page right now" is one idea. */
function AutoStrip({
  published,
  emptyMessage,
  cards,
  textOverImage = false,
  align = "center",
}: {
  published: boolean;
  emptyMessage: string;
  cards: { key: string; title: string; caption: string; coverUrl: string | null }[];
  /** How the SITE draws this row's cards — see `LinkCardTile`. An event cover
   *  is a poster and stands alone; a post's hero carries the title over it. */
  textOverImage?: boolean;
  align?: SiteLinkAlign;
}) {
  if (cards.length === 0) {
    return <Text className="mt-2 text-xs text-muted">{emptyMessage}</Text>;
  }
  return (
    <View className="mt-2">
      <Text className="mb-1.5 text-xs text-muted">
        {published
          ? "On the page right now:"
          : "Hidden — none of these are on the page right now:"}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {cards.map((card) => (
          <View key={card.key} className="w-[92px]">
            <LinkCardTile
              title={card.title}
              subtitle={card.caption}
              bgImage={card.coverUrl}
              align={align}
              textOverImage={textOverImage}
              dimmed={!published}
            />
            <Text className="mt-1 text-2xs text-ink" numberOfLines={1}>
              {card.title}
            </Text>
            <Text className="text-2xs text-faint" numberOfLines={1}>
              {card.caption}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
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
export function LiveEventStrip({
  cards,
  maxEvents,
  published,
}: {
  cards: LiveEventCard[];
  maxEvents: number;
  published: boolean;
}) {
  return (
    <AutoStrip
      published={published}
      emptyMessage={
        maxEvents === 0
          ? "Set to none — the page shows no event cards here."
          : "Nothing published is coming up, so the page shows no event cards here."
      }
      cards={cards.map((ev) => ({
        key: ev.slug,
        title: ev.title,
        caption: `${formatEventDay(ev.startDate)}${ev.pinned ? " · leading" : ""}`,
        coverUrl: ev.coverUrl,
      }))}
    />
  );
}

/**
 * The post cards that are on the page right now, on the same terms —
 * `postPreview` is resolved with the row forced published too.
 *
 * Drawn differently from the event tiles, because the SITE draws them
 * differently: `buildPostCard` keeps the title on the card over a scrim and
 * sets it left, where an event's cover poster stands alone. A desk preview that
 * flattened the two would be showing a card the page does not render.
 */
export function LivePostStrip({
  cards,
  maxPosts,
  published,
}: {
  cards: LivePostCard[];
  maxPosts: number;
  published: boolean;
}) {
  return (
    <AutoStrip
      published={published}
      textOverImage
      align="topLeft"
      emptyMessage={
        maxPosts === 0
          ? "Set to none — the page shows no post cards here."
          : "Nothing is published on the blog yet, so the page shows no post cards here."
      }
      cards={cards.map((post) => ({
        key: post.slug,
        title: post.title,
        caption: `${formatPostDay(post.publishedAt)}${post.pinned ? " · leading" : ""}`,
        coverUrl: post.coverUrl,
      }))}
    />
  );
}

/** The two toggles a picker row carries. Pin and hide are mutually exclusive on
 *  one thing: hide wins in the resolver, so letting both be ticked would show a
 *  state the site ignores. Ticking one unticks the other. */
function PickerToggles({
  slug,
  pinned,
  hidden,
  onPin,
  onHide,
}: {
  slug: string;
  pinned: string[];
  hidden: string[];
  onPin: (slug: string) => void;
  onHide: (slug: string) => void;
}) {
  return (
    <>
      <Pressable onPress={() => onPin(slug)} accessibilityRole="button">
        <Badge label="Lead with" tone={pinned.includes(slug) ? "accent" : "neutral"} />
      </Pressable>
      <Pressable onPress={() => onHide(slug)} accessibilityRole="button">
        <Badge label="Hide" tone={hidden.includes(slug) ? "warn" : "neutral"} />
      </Pressable>
    </>
  );
}

/** The count picker both rows lead with. 0 is "None" and keeps the row (and its
 *  position) while showing nothing — different from unpublishing it only in
 *  that the marketer can see it is deliberate. */
function countOptionsUpTo(cap: number, noun: string) {
  return Array.from({ length: cap + 1 }, (_, n) => ({
    value: String(n),
    label: n === 0 ? "None" : `${n} ${noun}${n === 1 ? "" : "s"}`,
  }));
}

/** Save/Done, identical on both rows. */
function EditorActions({
  dirty,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Button title="Save" size="sm" disabled={!dirty} onPress={onSave} />
      <Button title="Done" size="sm" variant="ghost" onPress={onCancel} />
    </View>
  );
}

/** The live-events row's own controls. Separate from `LinkCardForm` because it
 *  shares none of its fields — it is a rule, not a card. */
export function EventsRowEditor({
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
        options={countOptionsUpTo(SITE_LINK_MAX_EVENTS_CAP, "card")}
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
              <PickerToggles
                slug={ev.slug}
                pinned={pinned}
                hidden={hidden}
                onPin={togglePin}
                onHide={toggleHide}
              />
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

      <EditorActions
        dirty={dirty}
        onCancel={onCancel}
        onSave={() =>
          onSave({
            maxEvents: Number(max),
            pinnedEventSlugs: pinned,
            hiddenEventSlugs: hidden,
          })
        }
      />
    </View>
  );
}

/**
 * The latest-posts row's controls — the events row's three questions, asked
 * about posts.
 *
 * Two things are its own rather than the events row's. The picker is behind a
 * disclosure (see the module doc: the blog only grows, and the count is the
 * only thing this row needs). And a leftover setting is reported by SLUG when
 * the post behind it is gone entirely, because a deleted post has no title left
 * to print and "an address the homepage is told to lead with, that goes
 * nowhere" is exactly the dead state that has to stay visible.
 */
export function PostsRowEditor({
  row,
  pinnable,
  onSave,
  onCancel,
}: {
  row: LinkRow;
  pinnable: PinnablePost[];
  onSave: (next: {
    maxPosts: number;
    pinnedPostSlugs: string[];
    hiddenPostSlugs: string[];
  }) => void;
  onCancel: () => void;
}) {
  // Seeded once, never re-synced — see `EventsRowEditor` for why.
  const [max, setMax] = useState(String(row.maxPosts ?? 0));
  const [pinned, setPinned] = useState<string[]>(row.pinnedPostSlugs ?? []);
  const [hidden, setHidden] = useState<string[]>(row.hiddenPostSlugs ?? []);
  // Open when the row already leads with or hides something: collapsing a
  // control with content in it hides the thing the marketer came to change.
  const [pickerOpen, setPickerOpen] = useState(
    () =>
      (row.pinnedPostSlugs?.length ?? 0) > 0 ||
      (row.hiddenPostSlugs?.length ?? 0) > 0,
  );

  const dirty =
    Number(max) !== (row.maxPosts ?? 0) ||
    pinned.join("|") !== (row.pinnedPostSlugs ?? []).join("|") ||
    hidden.join("|") !== (row.hiddenPostSlugs ?? []).join("|");

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
  function clear(slug: string) {
    setPinned((prev) => prev.filter((s) => s !== slug));
    setHidden((prev) => prev.filter((s) => s !== slug));
  }

  const live = pinnable.filter((p) => p.isPublished);

  /**
   * Settings pointing at something the homepage will never render.
   *
   * A post can be taken down or deleted after it was pinned, and
   * `resolvePostCards` skips a slug that names nothing published — correctly,
   * because the alternative is a 404 on the front page. The setting SURVIVES
   * that, though, and left unshown it is dead state: invisible, unclearable,
   * and armed to fire again the day someone republishes the post. So both
   * shapes of leftover are listed here, outside the disclosure, because the
   * whole point is that they cannot be missed:
   *
   *   taken down — the picker still knows the post, so it has a title.
   *   gone       — the picker has never heard of it (deleted, or renamed
   *                before the freeze), so its address is all there is to show.
   *
   * Only posts carrying a SETTING appear, which is where this parts company
   * with the events row's "Recently finished" list. That list answers "where
   * did last Saturday's card go?", a question about a grid that empties itself
   * on a schedule. Nothing takes a post off the homepage but a person, so a
   * taken-down post with nothing set on it is just a post the Blog tab already
   * accounts for, and listing it here would be padding.
   */
  const takenDown = pinnable
    .filter((p) => !p.isPublished)
    .filter((p) => pinned.includes(p.slug) || hidden.includes(p.slug))
    .map((p) => ({ slug: p.slug, label: p.title }));
  const known = new Set(pinnable.map((p) => p.slug));
  const gone = Array.from(new Set([...pinned, ...hidden]))
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, label: `/blog/${slug}` }));
  const leftovers = [...takenDown, ...gone];

  const pinnedCount = pinned.length;
  const hiddenCount = hidden.length;
  const pickerSummary =
    pinnedCount === 0 && hiddenCount === 0
      ? "Newest first — picking your own is optional."
      : [
          pinnedCount > 0 ? `Leading with ${pinnedCount}` : null,
          hiddenCount > 0 ? `${hiddenCount} kept off` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <View className="mt-3 border-t border-border pt-3">
      <Text className="mb-3 text-xs text-muted">
        The number of cards is the only thing this row needs. Leading with a
        post, or keeping one off, is optional.
      </Text>

      <Select
        label="How many post cards"
        value={max}
        options={countOptionsUpTo(SITE_LINK_MAX_POSTS_CAP, "card")}
        onChange={setMax}
        hint="Newest first, unless you lead with one below."
      />

      <Pressable
        onPress={() => setPickerOpen((open) => !open)}
        accessibilityRole="button"
        className="mb-3 flex-row items-center gap-1.5 py-1"
      >
        <Icon
          name={pickerOpen ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.accent}
        />
        <Text className="text-sm font-semibold text-accent">
          {pickerOpen ? "Fewer options" : "Choose which posts"}
        </Text>
        {pickerOpen ? null : (
          <Text className="flex-1 text-xs text-muted" numberOfLines={1}>
            {pickerSummary}
          </Text>
        )}
      </Pressable>

      {pickerOpen ? (
        live.length === 0 ? (
          <Text className="mb-3 text-xs text-muted">
            Nothing is published on the blog yet — publish a post from the Blog
            tab and it shows up here.
          </Text>
        ) : (
          <View className="mb-3">
            <Text className="mb-2 text-xs text-muted">
              Lead with a post to put it first even if it isn't the newest. Hide
              one to keep it off the homepage entirely.
            </Text>
            {live.map((post) => (
              <View
                key={post.slug}
                className="mb-2 flex-row items-center justify-between gap-2"
              >
                <View className="flex-1">
                  <Text className="text-sm text-ink" numberOfLines={1}>
                    {post.title}
                  </Text>
                  <Text className="text-xs text-faint" numberOfLines={1}>
                    {formatPostDay(post.publishedAt)} · /blog/{post.slug}
                  </Text>
                </View>
                {post.onPageNow ? (
                  <Badge label="On the page" tone="success" />
                ) : null}
                <PickerToggles
                  slug={post.slug}
                  pinned={pinned}
                  hidden={hidden}
                  onPin={togglePin}
                  onHide={toggleHide}
                />
              </View>
            ))}
          </View>
        )
      ) : null}

      {leftovers.length > 0 ? (
        <View className="mb-3">
          <Text className="mb-1.5 text-sm font-semibold text-ink">
            No longer on the blog
          </Text>
          <Text className="mb-2 text-xs text-muted">
            The homepage already skips these, so nothing is broken. Clear the
            setting so it doesn't come back on its own if the post is published
            again.
          </Text>
          {leftovers.map((item) => (
            <View
              key={item.slug}
              className="mb-1.5 flex-row items-center justify-between gap-2"
            >
              <Text className="flex-1 text-xs text-faint" numberOfLines={1}>
                {item.label}
              </Text>
              <Badge
                label={pinned.includes(item.slug) ? "Leading" : "Hidden"}
                tone="neutral"
              />
              <Button
                title="Clear"
                size="sm"
                variant="ghost"
                onPress={() => clear(item.slug)}
              />
            </View>
          ))}
        </View>
      ) : null}

      <EditorActions
        dirty={dirty}
        onCancel={onCancel}
        onSave={() =>
          onSave({
            maxPosts: Number(max),
            pinnedPostSlugs: pinned,
            hiddenPostSlugs: hidden,
          })
        }
      />
    </View>
  );
}
