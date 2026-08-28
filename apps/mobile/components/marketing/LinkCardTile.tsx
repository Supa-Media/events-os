/**
 * A card as the SITE draws it, at desk size.
 *
 * The Links screen was a list of database rows — a title, a URL, a badge — and
 * the founder's read of it was "the links and the site stuff just doesn't
 * work… I wanna see the things that already appear in that section kinda show
 * up here." The rows were right. They just did not LOOK like anything on
 * publicworship.life, so matching a row to the tile it produces meant opening
 * the site in another tab and reading titles off both.
 *
 * So this is a deliberate small copy of `apps/landing/src/components/ui/
 * LinkCard.astro` — the same pink tile, the same rule for what a card actually
 * shows:
 *
 *   background photo → the photo, and NOTHING else (the card becomes a poster)
 *   photo + text     → the photo with the title over a scrim (`textOverImage`)
 *   logo             → the logo, no title
 *   neither          → the title, in the display serif, in link blue
 *
 * The second case is the newest and it belongs to the blog posts: the site's
 * `buildPostCard` puts the title on the card either way, because a post's hero
 * is an arbitrary photograph that says nothing, where an event's cover is a
 * poster with the event's own name set into it. Same reasoning, one prop.
 *
 * Copied rather than shared, which is the one thing to be careful about: the
 * landing card is Astro + Tailwind CSS and this is React Native, so there is no
 * component to import — only the rule. It is small, and it is now named in the
 * module doc on this side; if the site's cards grow another case this is the
 * file that has to learn it. The colors are not re-picked by eye either:
 * `bg-brand-100` and `text-info` are already the site's `pink-softer` and
 * `link-blue`, to the hex.
 *
 * The live event cards render through here too, and not as a convenience: the
 * site builds them from the same markup (`siteContent.ts#buildEventCard` —
 * cover full-bleed, else title + date in link blue), so an event card IS a
 * link card whose background is the event's cover. The latest blog posts are
 * the same story with a hero image instead of a cover, which is why the desk's
 * two automatic rows (`LinksAutoRows.tsx`) preview through one strip.
 */
import { Image, Text, View } from "react-native";
import type { SiteLinkAlign, SiteLinkKind } from "@events-os/shared";
import { publicSiteUrl } from "../event/ticketing/helpers";

/**
 * One row of the Important Links grid, as `marketingSite.siteContent` returns
 * it. Lives here because the tile is what a row LOOKS like, and both the screen
 * and the form read the same shape.
 *
 * The two AUTO rows' overrides — how many, which to lead with, which to keep
 * off — are on the same type rather than a union, because they arrive on the
 * same query and `serializeLinkForDesk` sends them as `null` on a row that is
 * not that kind. A union would be more precise and would buy nothing: every
 * reader already asks `row.kind` first, and the desk-only fields would still
 * have to be narrowed one at a time at each tile.
 */
export type LinkRow = {
  id: string;
  kind: SiteLinkKind;
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
  maxPosts: number | null;
  pinnedPostSlugs: string[] | null;
  hiddenPostSlugs: string[] | null;
};

/**
 * A card image's path, as something `<Image>` can actually load.
 *
 * Every image the backend hands this screen is site-relative — `/links/…` for
 * art still living in the landing repo, `/api/site/link-image/<id>` for an OS
 * upload, `/rsvp/<slug>/cover` for an event cover. A relative uri resolves
 * against the app's own origin on web and against nothing at all on native, so
 * the old picker's preview was a broken frame on a phone. Absolutized against
 * `publicSiteUrl()` — the app's single answer to "where do the public routes
 * live" — which in prod is the same branded host that serves the repo art.
 */
export function siteImageUri(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:/i.test(path)) return path;
  const base = publicSiteUrl().replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * The tile. Sized once here rather than per caller so a row of them lines up.
 *
 * The card's "small line" (`cta`) is deliberately not drawn: three lines of
 * type do not survive 62 pixels, and the row beside the tile already spells out
 * what the card does. Everything that changes the tile's SHAPE — background,
 * logo, alignment — is drawn, because that is what a marketer is checking.
 */
export function LinkCardTile({
  title,
  subtitle,
  thumbnail,
  bgImage,
  align = "center",
  dimmed = false,
  textOverImage = false,
}: {
  title: string;
  subtitle?: string | null;
  thumbnail?: string | null;
  bgImage?: string | null;
  align?: SiteLinkAlign;
  /** Faded, for a card that is not on the site right now. */
  dimmed?: boolean;
  /** Keep the title and subtitle ON the photo, over a scrim, instead of
   *  letting the photo stand alone — the blog posts' card. */
  textOverImage?: boolean;
}) {
  const bg = siteImageUri(bgImage);
  const thumb = siteImageUri(thumbnail);
  return (
    <View
      className={`h-[62px] w-[92px] overflow-hidden rounded-md bg-brand-100 ${
        dimmed ? "opacity-40" : ""
      }`}
    >
      {bg && textOverImage ? (
        <View className="flex-1">
          <Image
            source={{ uri: bg }}
            className="absolute h-full w-full"
            resizeMode="cover"
            // Decorative: the title sitting on top of it already says this.
            accessibilityElementsHidden
          />
          {/* The photograph is arbitrary, so the type needs its own ground —
              the same reason the site's post card carries a gradient. */}
          <View className="absolute h-full w-full bg-black/45" />
          <View className="flex-1 justify-end gap-0.5 px-1.5 py-1">
            <Text
              numberOfLines={2}
              className="font-display text-[10px] leading-[12px] text-white"
            >
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} className="text-[8px] text-white">
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
      ) : bg ? (
        <Image
          source={{ uri: bg }}
          className="h-full w-full"
          resizeMode="cover"
          accessibilityLabel={title}
        />
      ) : (
        <View
          className={`flex-1 justify-center gap-0.5 px-1.5 ${
            align === "center" ? "items-center" : "items-start"
          }`}
        >
          {thumb ? (
            <Image
              source={{ uri: thumb }}
              className="h-5 w-full"
              resizeMode="contain"
              accessibilityLabel={title}
            />
          ) : (
            <Text
              numberOfLines={2}
              className={`font-display text-[10px] leading-[12px] text-info ${
                align === "center" ? "text-center" : ""
              }`}
            >
              {title}
            </Text>
          )}
          {subtitle ? (
            <Text
              numberOfLines={1}
              className={`text-[8px] text-info ${
                align === "center" ? "text-center" : ""
              }`}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
