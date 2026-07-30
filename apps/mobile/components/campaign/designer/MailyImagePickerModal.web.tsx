/**
 * The library-first replacement for maily's native-file-dialog image
 * placeholder (founder bug #2 — see `pwImagePlaceholderIntercept.ts`'s module
 * doc for the click-interception mechanics this sits behind).
 *
 * Reuses the SAME two controls the toolbar above the editor already offers
 * for inserting a NEW image (`ImageLibraryPicker`, `ImageUploadButton`) —
 * "Choose from library…" is the PRIMARY path (a designer reusing the
 * wordmark/venue shot/song art doesn't have to leave the editor at all),
 * "Upload new…" is the secondary path for something genuinely new. No new
 * data-fetching component: `ImageLibraryPicker` already owns the `emailImages`
 * query and its own read-only/locked-document handling, so this modal is
 * pure layout around it.
 *
 * `.web.tsx` — only ever mounted by `MailyDocumentHost.web.tsx` (the maily
 * editor is web-only; native stays read-only, no image insertion at all).
 * The outer overlay/backdrop are plain `<div>`s, not RN `View`s, for the same
 * reason `MailyDocumentHost.web.tsx`'s editor container is: `position:
 * "fixed"` isn't in RN's `ViewStyle` type at all (react-native-web renders it
 * fine at runtime, but `View`'s TYPES reject it) — a real DOM element needs
 * no such workaround.
 *
 * ── founder bug #3: "renders at the top" instead of near the clicked image ──
 * `position: fixed` computes relative to the VIEWPORT only when NO ancestor
 * establishes a CSS containing block of its own (a `transform`/`filter`/
 * `perspective`/`will-change: transform` ancestor does). `react-native-web`'s
 * `ScrollView` (what `components/ui/Screen.tsx` wraps every page in, via
 * `KeyboardAwareScrollView`) sets exactly that: `transform: translateZ(0)`
 * on its scrolling element, for GPU-layer compositing
 * (`react-native-web/dist/exports/ScrollView/index.js`'s `commonStyle`).
 * Confirmed in the harness (`__adv__/harness/entry-v2.tsx`, which wraps the
 * SAME real `MailyDocumentHost` in a real `ScrollView` to reproduce this):
 * once nested inside that ancestor, `inset: 0` no longer covers the true
 * browser viewport — it covers the SCROLLVIEW's own (unscrolled) box, which
 * sits at the top of the page, so the overlay renders pinned near the TOP
 * regardless of how far the designer scrolled to reach a low image.
 *
 * The fix is the standard escape for this class of bug: render the overlay
 * through `createPortal` into `document.body`, which is (barring something
 * even the framework doesn't do) never itself inside a transformed ancestor —
 * `position: fixed` there is unconditionally viewport-relative, independent
 * of where in the React tree this component happens to be mounted, and of
 * any ancestor's scroll position.
 */
import { createPortal } from "react-dom";
import { Pressable, Text, View } from "react-native";
import { ImageUploadButton, type UploadedImage, type UploadImage } from "./DesignerControls";
import { ImageLibraryPicker } from "./ImageLibraryPicker";
import type { ActionRunner } from "../../../lib/useActionToast";

export function MailyImagePickerModal({
  onClose,
  onPick,
  uploadImage,
  run,
  onUploaded,
}: {
  onClose: () => void;
  onPick: (image: { url: string; alt: string }) => void;
  uploadImage: UploadImage | undefined;
  run: ActionRunner["run"];
  /** Same shape as the toolbar's own `ImageUploadButton` callback — the
   *  `storageId` rides along so the caller can register the upload into the
   *  shared image library exactly like every other upload path does. */
  onUploaded: (uploaded: UploadedImage, suggestedLabel: string) => void;
}) {
  // `document.body`, not the component's own React-tree parent — see the
  // module doc's founder-bug-#3 section: this is the ONLY way `position:
  // fixed` below is guaranteed viewport-relative regardless of any ancestor
  // (a `ScrollView`, in production) establishing its own CSS containing
  // block. `document` only exists once mounted in a real browser, which is
  // exactly when this component ever renders (`.web.tsx`, always inside a
  // DOM — no SSR path calls this).
  return createPortal(
    <div
      role="presentation"
      style={{
        // `fixed`, not `absolute` — this overlay must cover the actual
        // browser VIEWPORT so the panel centers on screen regardless of how
        // tall the scrollable editor document is (an `absolute` `inset:0`
        // here sizes to the nearest positioned ancestor, which for a long
        // newsletter is the whole multi-thousand-pixel-tall document —
        // "centered" in that box lands far below the fold, near wherever the
        // designer happened to click).
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(33,9,9,0.35)",
      }}
    >
      <div
        aria-label="Close"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, cursor: "default", zIndex: 0 }}
      />
      <View
        className="rounded-lg border border-border bg-raised p-4"
        // Belt-and-suspenders alongside the NativeWind `className` above:
        // matches it exactly, just inline. NativeWind resolves the className
        // at build time in the real Metro app (this is redundant there); it's
        // load-bearing only for a plain-esbuild consumer that never runs the
        // NativeWind babel transform — this repo's `__adv__/harness/`.
        //
        // `zIndex: 1` — EXPLICIT and higher than the backdrop's (`0`), not
        // just "later in the JSX". Both this panel and the backdrop above are
        // `position`ed (the backdrop `fixed`; RNW's own `View` base style
        // gives this panel `position: relative` by default), and — measured
        // directly via `document.elementFromPoint` in the harness — DOM order
        // alone was NOT reliably deciding paint order between them once
        // portaled to `document.body` (a click on "Choose from library…"
        // was landing on the backdrop instead, silently closing the modal).
        // An explicit `zIndex` removes the ambiguity outright.
        style={{
          width: 360,
          maxWidth: "90%",
          backgroundColor: "#FFFFFF",
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#EFE0DC",
          padding: 16,
          zIndex: 1,
        }}
      >
        <View
          className="mb-3 flex-row items-center justify-between"
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}
        >
          <Text className="text-sm font-bold text-ink" style={{ fontSize: 13, fontWeight: "700", color: "#210909" }}>
            Insert image
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text
              className="text-xs font-semibold text-muted"
              style={{ fontSize: 12, fontWeight: "600", color: "#7A5A5A" }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        <ImageLibraryPicker
          onPick={(image) => {
            onPick(image);
            onClose();
          }}
        />

        {uploadImage ? (
          <ImageUploadButton
            uploadImage={uploadImage}
            run={run}
            label="Upload new…"
            onUploaded={(uploaded, suggestedLabel) => {
              onUploaded(uploaded, suggestedLabel);
              onClose();
            }}
          />
        ) : null}
      </View>
    </div>,
    document.body,
  );
}

export default MailyImagePickerModal;
