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
 * LinkCard.astro` — the same pink tile, the same three-way rule for what a
 * card actually shows:
 *
 *   background photo → the photo, and NOTHING else (the card becomes a poster)
 *   logo             → the logo, no title
 *   neither          → the title, in the display serif, in link blue
 *
 * Copied rather than shared, which is the one thing to be careful about: the
 * landing card is Astro + Tailwind CSS and this is React Native, so there is no
 * component to import — only the rule. It is small, and it is now named in the
 * module doc on this side; if `LinkCard.astro` grows a fourth case this is the
 * file that has to learn it. The colors are not re-picked by eye either:
 * `bg-brand-100` and `text-info` are already the site's `pink-softer` and
 * `link-blue`, to the hex.
 *
 * The live event cards render through here too, and not as a convenience: the
 * site builds them from the same markup (`siteContent.ts#buildEventCard` —
 * cover full-bleed, else title + date in link blue), so an event card IS a
 * link card whose background is the event's cover.
 */
import { Image, Text, View } from "react-native";
import type { SiteLinkAlign } from "@events-os/shared";
import { publicSiteUrl } from "../event/ticketing/helpers";

/** One row of the Important Links grid, as `marketingSite.siteContent` returns
 *  it. Lives here because the tile is what a row LOOKS like, and both the
 *  screen and the form read the same shape. */
export type LinkRow = {
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
}: {
  title: string;
  subtitle?: string | null;
  thumbnail?: string | null;
  bgImage?: string | null;
  align?: SiteLinkAlign;
  /** Faded, for a card that is not on the site right now. */
  dimmed?: boolean;
}) {
  const bg = siteImageUri(bgImage);
  const thumb = siteImageUri(thumbnail);
  return (
    <View
      className={`h-[62px] w-[92px] overflow-hidden rounded-md bg-brand-100 ${
        dimmed ? "opacity-40" : ""
      }`}
    >
      {bg ? (
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
