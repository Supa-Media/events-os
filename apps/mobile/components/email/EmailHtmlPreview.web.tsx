/**
 * Web preview: a sandboxed `<iframe srcDoc>` — RN-web renders `<iframe>`
 * directly in the DOM (same technique as `BriefingView`'s video embed). The
 * campaign HTML is fully self-contained (inlined styles, no external
 * resources besides the recipient's own images), so `srcDoc` alone renders it
 * faithfully with no extra plumbing.
 *
 * ── `height="auto"` (2026-07-30 founder bug) ────────────────────────────────
 * Verbatim: "I don't see a reason why we can't preview more than just a
 * little section as well. Like, it's weird that we can't see the whole
 * thing." Every caller used to pass a fixed pixel height into a
 * `overflow-hidden` box, so a real ~3,500px newsletter showed its top ~15%,
 * clipped mid-word, with the rest reachable only by scrolling INSIDE the
 * iframe. `height="auto"` instead measures the rendered document and grows
 * the box to fit it, so the whole email lays out in the page and scrolls with
 * everything else — the way a design tool previews a design.
 *
 * Measuring means reading `iframe.contentDocument`, which an opaque-origin
 * (`sandbox=""`) frame refuses. So auto mode uses
 * `sandbox="allow-same-origin"` — and NOT `allow-scripts`, which is what
 * actually keeps the document inert: without that token no script inside the
 * frame can run at all, so same-origin buys us the measurement and nothing
 * else. (The HTML is server-sanitized upstream too — `emailHtmlSanitize.ts`
 * — so this is the second line, not the only one. Fixed-height mode keeps
 * the stricter `sandbox=""` since it never needs to read the document.)
 *
 * Re-measuring matters as much as measuring: images inside the email finish
 * loading after the frame's own `load` event, and each one that arrives
 * changes the height. Both a `ResizeObserver` on the document element and a
 * per-image `load`/`error` listener re-run the measurement.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { colors } from "../../lib/theme";
import type { EmailHtmlPreviewProps } from "./EmailHtmlPreview";

/** Where the box sits until the first measurement lands — tall enough not to
 *  flash a sliver, short enough not to shove the page around. */
const AUTO_HEIGHT_PLACEHOLDER = 560;
/** A runaway backstop, not a design constraint: nothing legitimate renders
 *  taller than this, and an unbounded height from a pathological document
 *  shouldn't be able to lock up the page's layout. */
const AUTO_HEIGHT_CAP = 40_000;

function measureDocumentHeight(frame: HTMLIFrameElement): number | null {
  let doc: Document | null | undefined;
  try {
    doc = frame.contentDocument;
  } catch {
    // Cross-origin (a caller kept the stricter sandbox) — not measurable.
    return null;
  }
  if (!doc?.documentElement) return null;
  const height = Math.max(
    doc.documentElement.scrollHeight,
    doc.documentElement.offsetHeight,
    doc.body?.scrollHeight ?? 0,
    doc.body?.offsetHeight ?? 0,
  );
  if (!Number.isFinite(height) || height <= 0) return null;
  return Math.min(height, AUTO_HEIGHT_CAP);
}

export function EmailHtmlPreview({ html, height = 560 }: EmailHtmlPreviewProps) {
  const auto = height === "auto";
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** Tears down the listeners/observer attached to the CURRENT document —
   *  replaced on every load, run on unmount. */
  const cleanupRef = useRef<(() => void) | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  // A new document invalidates the old measurement — otherwise the box keeps
  // the previous email's height until the new one happens to load.
  useEffect(() => {
    if (auto) setMeasured(null);
  }, [auto, html]);

  const remeasure = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const next = measureDocumentHeight(frame);
    // `+2` absorbs sub-pixel rounding that would otherwise leave the iframe
    // one scrollable pixel short of its own content.
    if (next !== null) setMeasured(next + 2);
  }, []);

  const handleLoad = useCallback(() => {
    if (!auto) return;
    // A reload means the previous document (and everything attached to it) is
    // gone — drop those listeners before wiring up the new one's.
    cleanupRef.current?.();
    cleanupRef.current = null;
    remeasure();
    const frame = frameRef.current;
    let doc: Document | null | undefined;
    try {
      doc = frame?.contentDocument;
    } catch {
      return;
    }
    if (!doc) return;

    const cleanups: (() => void)[] = [];
    for (const image of Array.from(doc.images)) {
      if (image.complete) continue;
      image.addEventListener("load", remeasure);
      image.addEventListener("error", remeasure);
      cleanups.push(() => {
        image.removeEventListener("load", remeasure);
        image.removeEventListener("error", remeasure);
      });
    }
    // Fonts, late layout, an `@media` rule resolving — anything that changes
    // the document's box after load.
    const view = doc.defaultView;
    if (view && "ResizeObserver" in view) {
      const observer = new view.ResizeObserver(remeasure);
      observer.observe(doc.documentElement);
      cleanups.push(() => observer.disconnect());
    }
    cleanupRef.current = () => cleanups.forEach((fn) => fn());
  }, [auto, remeasure]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const boxHeight = auto ? (measured ?? AUTO_HEIGHT_PLACEHOLDER) : (height as number);

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised" style={{ height: boxHeight }}>
      <iframe
        ref={frameRef}
        srcDoc={html}
        title="Email preview"
        onLoad={handleLoad}
        // Never `allow-scripts` — that's the token that would let this
        // author-written content execute. See the module doc for why auto
        // mode needs `allow-same-origin` and why it's safe without scripts.
        sandbox={auto ? "allow-same-origin" : ""}
        style={{
          width: "100%",
          height: "100%",
          border: "0",
          backgroundColor: colors.raised,
          // In auto mode the OUTER box is already the document's height, so
          // the frame must not also offer its own scrollbar.
          overflow: auto ? "hidden" : undefined,
        }}
        scrolling={auto ? "no" : undefined}
      />
    </View>
  );
}

export default EmailHtmlPreview;
