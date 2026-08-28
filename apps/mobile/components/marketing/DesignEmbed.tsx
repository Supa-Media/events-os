/**
 * MARKETING · Designs — one design's LIVE preview, and the way out of it.
 *
 * The founder's ask for this tab was specific: "it should ideally render, so
 * you can click in, and then it renders, but you can click in and go to the
 * full thing." Both halves live here, in one component, because they are one
 * decision — whatever we can show inline, we show; whatever we can't, we say so
 * and hand over to the real tool. A preview without a way out is a dead end, and
 * a link without a preview is the Google Doc of design libraries.
 *
 * ── The viewer's copy of the preview ────────────────────────────────────────
 * This component is mounted only by `DesignInspector`, for the one file
 * somebody opened. The GRID now previews live too — on web every Canva/Figma
 * tile carries its own lazy frame (`designs/DesignGrid`, founder's call:
 * "just render the iframe for all of them"), so this frame is the big,
 * interactive copy rather than the only one. The grid's frames are inert
 * (`pointerEvents: none`); this one you can actually page through.
 *
 * ── Web renders a frame. Native does not, on purpose ────────────────────────
 * On web an embeddable design becomes a real `<iframe>` in a 16/9 box, copied
 * from `crew/BriefingView.tsx`'s video branch (react-native-web renders the tag
 * straight into the DOM).
 *
 * On native it stays a still image plus an "Open in Canva" button, and the
 * `react-native-webview` this repo already ships is deliberately NOT used:
 *
 *  - A Canva or Figma document is an authenticated, desktop-width canvas. In a
 *    phone-width WebView the honest outcomes are a sign-in wall or artwork too
 *    small to judge — which is worse than the thumbnail, not better.
 *  - Tapping through should land in the Canva/Figma APP, where the marketer's
 *    account already is and where they can actually edit. `Linking.openURL`
 *    does that; a WebView traps them in a read-only copy inside our app.
 *  - It keeps this screen's bundle free of a WebView and of third-party JS,
 *    and keeps the file a single `.tsx` rather than the three-file split
 *    `NativePdfPane` needs.
 *
 * ── A null `embedUrl` must never become a frame ─────────────────────────────
 * `designEmbedUrl` returns null for anything it doesn't recognise, expressly so
 * that callers fall back rather than render a broken box (its own doc says so).
 * This component's ladder is therefore embed → hosted still → nothing at all;
 * the open affordance is outside the ladder and shows for every kind.
 *
 * The still is `imageUrl ?? thumbnailUrl`, and both are uploads we host — never
 * a Canva CDN preview, which expires (see the shared module's CDN note).
 */
import { Image, Linking, Platform, Text, View } from "react-native";
import { DESIGN_KIND_LABELS, type DesignKind } from "@events-os/shared";
import { Button } from "../ui";

type Props = {
  kind: DesignKind;
  /** The design's title — the frame's accessible name, and the image's. */
  title: string;
  /** `designEmbedUrl(url)` from the server. Null = not embeddable. */
  embedUrl: string | null;
  /** Where the design really lives, for the open affordance. */
  url: string | null;
  /** Hosted artwork for an `image` design. */
  imageUrl: string | null;
  /** Hosted thumbnail, any kind. */
  thumbnailUrl: string | null;
};

/** What the button says. Naming the tool ("Open in Canva") rather than saying
 *  "Open" is the difference between knowing where a tap lands and finding out. */
function openLabel(kind: DesignKind): string {
  if (kind === "canva" || kind === "figma") {
    return `Open in ${DESIGN_KIND_LABELS[kind]}`;
  }
  return kind === "image" ? "Open full size" : "Open link";
}

export function DesignEmbed({
  kind,
  title,
  embedUrl,
  url,
  imageUrl,
  thumbnailUrl,
}: Props) {
  // Narrowed into a const rather than tested inline so the JSX below hands the
  // iframe a `string`, not a `string | null` with a non-null assertion.
  const frame = Platform.OS === "web" ? embedUrl : null;
  const still = imageUrl ?? thumbnailUrl;
  // An `image` design's own artwork is the thing to open when it has no URL.
  const target = url ?? imageUrl;

  return (
    <View className="mt-2">
      {frame ? (
        <View
          className="w-full overflow-hidden rounded-lg border border-border bg-sunken"
          style={{ aspectRatio: 16 / 9 }}
        >
          {/* RN-web renders this iframe directly in the DOM. */}
          <iframe
            src={frame}
            title={title}
            loading="lazy"
            allowFullScreen
            style={{ width: "100%", height: "100%", border: "0" }}
          />
        </View>
      ) : still ? (
        <Image
          source={{ uri: still }}
          accessibilityLabel={title}
          className="w-full rounded-lg border border-border bg-sunken"
          style={{ aspectRatio: 16 / 9 }}
          resizeMode="contain"
        />
      ) : null}

      {/* Only said when there IS an embed we're choosing not to render — so the
          line explains an absence rather than nagging about every link row. */}
      {embedUrl && !frame && !still ? (
        <Text className="text-xs text-muted">
          Opens in {DESIGN_KIND_LABELS[kind]} here; the web app previews it
          inline.
        </Text>
      ) : null}

      {target ? (
        <View className="mt-2 flex-row">
          <Button
            title={openLabel(kind)}
            icon="external-link"
            size="sm"
            variant="secondary"
            onPress={() => void Linking.openURL(target)}
          />
        </View>
      ) : null}
    </View>
  );
}
