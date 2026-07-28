/**
 * The editor for ONE `EmailCardContent` — how the card is painted, its image,
 * its copy, and its call to action.
 *
 * Written once and used twice, exactly as the shared shape intends: the
 * full-width `card` block edits a single one of these, and the `columns`
 * block edits 2-3 of them side by side. `emailBlocks.ts` calls this out as
 * the reason `EmailCardContent` exists at all ("the renderer, the validator,
 * and the composer editor are each written once"), so duplicating this per
 * block kind would defeat the contract's whole point.
 *
 * ── The fields follow the variant ──────────────────────────────────────────
 * A card carries eleven fields now, and showing all eleven at once turns the
 * one control that matters (the variant — it decides the fill, the alignment,
 * the heading size and the button style in one tap) into the twelfth thing on
 * a scroll. So the layout-dependent fields appear only where they DO
 * something: the image side and its column width need an image, the width
 * needs the image to be beside the text rather than above it, and the
 * attribution line is the testimonial's own field.
 *
 * The one rule that overrides that: a field is never hidden while it still
 * holds content. The renderer paints `attribution` on every variant, so
 * hiding a filled one behind a variant switch would leave a line in the email
 * with nothing in the editor to explain it — a field that's set stays visible
 * whatever the variant says.
 *
 * ── The validation rules live HERE, inline ─────────────────────────────────
 * `validateEmailDocument` rejects a card whose `imageAlt` is missing while
 * `imageUrl` is set, one where exactly one of `ctaLabel`/`ctaUrl` is filled,
 * and one whose `ctaUrl` carries a scheme outside http/https/mailto. All
 * three are easy to hit by accident and all fail at SAVE time, server-side,
 * long after the mistake — so each is mirrored as a field-level hint the
 * moment it's true. The hints are advisory-looking (they don't block typing)
 * but they name the exact fix.
 *
 * They mirror the validator EXACTLY, raw-string semantics and all — the
 * predicates live in `lib/emailDesigner.ts` so they can be pinned against
 * `validateEmailDocument` itself in a unit test. A hint that's merely
 * approximately right is worse than none: the document is rejected WHOLE, so
 * a state the server refuses but the form calls fine reads as "the editor
 * stopped saving" across every other block on the page.
 *
 * Choosing an image ALWAYS writes `imageAlt` alongside `imageUrl` (as `""`
 * when there's nothing better), because "" is the contract's legitimate
 * "decorative" value and `undefined` is the one that makes the document
 * unsaveable. The empty-alt warning then nags visibly rather than silently
 * breaking autosave.
 */
import { Text, View } from "react-native";
import type { EmailCardContent } from "@events-os/shared";
import { Field, Select, TextField } from "../../ui";
import {
  CARD_VARIANT_OPTIONS,
  DEFAULT_IMAGE_WIDTH_PCT,
  IMAGE_WIDTH_PCT_STEP,
  MAX_IMAGE_WIDTH_PCT,
  MIN_IMAGE_WIDTH_PCT,
  cardCtaUrlProblem,
  ctaPairProblem,
  imageAltProblem,
  stepImageWidthPct,
} from "../../../lib/emailDesigner";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";
import { ImageUploadButton, LevelToggle, type UploadImage } from "./DesignerControls";
import type { ActionRunner } from "../../../lib/useActionToast";

export function CardContentEditor({
  content,
  onChange,
  compact = false,
  uploadImage,
  run,
}: {
  content: EmailCardContent;
  /** Shallow patch. `undefined` CLEARS a field — the Convex client drops
   *  undefined keys on the wire, so this is how a field is removed rather
   *  than set to an empty string the validator would reject. */
  onChange: (patch: Partial<EmailCardContent>) => void;
  /** Narrower layout for a column — shorter labels, single-line body hint. */
  compact?: boolean;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  const library = useImageLibraryRegistration();

  const hasImage = typeof content.imageUrl === "string" && content.imageUrl.length > 0;
  // Two different failures, deliberately distinguished: a MISSING alt rejects
  // the document, an empty one is the contract's "decorative" and merely
  // earns an advisory. See `imageAltProblem`.
  const altProblem = imageAltProblem({ url: content.imageUrl, alt: content.imageAlt });
  // NOT `?.trim()`: the validator counts a field as filled on the RAW string
  // (`.length > 0`), so a label backspaced down to one stray space still
  // rejects the document when there's no url beside it. Trimming here left
  // that state warning-free in the form and fatal on save. See
  // `ctaPairProblem`, which is pinned against the real validator in
  // `lib/emailDesigner.test.ts`.
  const ctaProblem = ctaPairProblem(content);
  const ctaUrlProblem = cardCtaUrlProblem(content);

  const variant = content.variant ?? "plain";
  const imageSide = content.imageSide ?? "top";
  const beside = hasImage && (imageSide === "left" || imageSide === "right");
  // Shown for the testimonial, and for any card that already has one — see
  // the note at the top about never hiding a field that holds content.
  const showAttribution =
    variant === "testimonial" || (content.attribution ?? "").length > 0;

  return (
    <View>
      <Select
        label="Style"
        value={variant}
        options={CARD_VARIANT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        onChange={(next) => onChange({ variant: next as EmailCardContent["variant"] })}
        hint={
          compact
            ? undefined
            : "The style sets the fill, the alignment, the headline size and the button — the theme still supplies every colour."
        }
      />

      <TextField
        label={compact ? "Image URL" : "Image"}
        value={content.imageUrl ?? ""}
        onChangeText={(imageUrl) => {
          onChange(
            imageUrl.trim()
              ? { imageUrl, imageAlt: content.imageAlt ?? "" }
              : // Clearing the URL clears the alt with it — an alt string
                // hanging off an imageless card is dead data that reappears
                // confusingly the next time an image is chosen.
                { imageUrl: undefined, imageAlt: undefined },
          );
          // A typed/pasted URL is a DIFFERENT image from the one this editor
          // uploaded, so the alt text written next must not be backfilled
          // onto that upload's library row.
          library.forget();
        }}
        placeholder="https://…"
        autoCapitalize="none"
        keyboardType="url"
      />

      <View className="mb-1 flex-row flex-wrap items-start gap-2">
        {uploadImage && run ? (
          <ImageUploadButton
            uploadImage={uploadImage}
            run={run}
            onUploaded={(uploaded, suggestedLabel) => {
              onChange({
                imageUrl: uploaded.url,
                // Always write an alt alongside the URL: `undefined` is the
                // one value that makes the document unsaveable, "" is the
                // contract's "decorative" and merely earns the warning below.
                imageAlt: content.imageAlt ?? "",
              });
              library.register(uploaded.storageId, suggestedLabel || "Campaign image");
            }}
          />
        ) : null}
        <ImageLibraryPicker
          onPick={({ url, alt }) => {
            onChange({ imageUrl: url, imageAlt: alt });
            // The picked row carries its own description already; editing the
            // alt field from here must not rewrite the row this editor's
            // upload created, which is now a different image entirely.
            library.forget();
          }}
        />
      </View>

      {hasImage ? (
        <TextField
          label="Alt text"
          value={content.imageAlt ?? ""}
          onChangeText={(imageAlt) => {
            onChange({ imageAlt });
            // Backfills the library row this editor just created, so the
            // description is written once and reused forever after.
            library.noteAlt(imageAlt);
          }}
          placeholder="What the image shows"
          hint={
            altProblem
              ? undefined
              : "Read aloud by screen readers, and shown in place of the image when a client blocks it."
          }
        />
      ) : null}
      {altProblem === "unsaveable" ? (
        <InlineWarning text={ALT_MISSING_WARNING} />
      ) : altProblem === "empty" ? (
        <InlineWarning text={ALT_EMPTY_WARNING} />
      ) : null}

      {/* Placement only exists once there IS an image — `imageSide` and
          `imageWidthPct` are both ignored by the renderer without one. */}
      {hasImage ? (
        <Field
          label={compact ? "Image" : "Image placement"}
          hint={
            beside
              ? undefined
              : "Above the text, full width of the card."
          }
        >
          <View className="flex-row flex-wrap gap-2">
            <LevelToggle
              label="Above"
              active={imageSide === "top"}
              onPress={() => onChange({ imageSide: "top" })}
            />
            <LevelToggle
              label="Left of text"
              active={imageSide === "left"}
              onPress={() => onChange({ imageSide: "left" })}
            />
            <LevelToggle
              label="Right of text"
              active={imageSide === "right"}
              onPress={() => onChange({ imageSide: "right" })}
            />
          </View>
        </Field>
      ) : null}

      {beside ? <ImageWidthControl content={content} onChange={onChange} /> : null}

      <TextField
        label="Eyebrow"
        value={content.eyebrow ?? ""}
        onChangeText={(eyebrow) => onChange({ eyebrow })}
        placeholder="Small line above the heading"
      />

      <TextField
        label="Heading"
        value={content.heading ?? ""}
        onChangeText={(heading) => onChange({ heading })}
        placeholder={compact ? "Column heading" : "Card heading"}
      />

      <TextField
        label={variant === "testimonial" ? "Quote" : "Body"}
        value={content.body ?? ""}
        onChangeText={(body) => onChange({ body })}
        placeholder="Supports **bold**, *italic*, [links](https://…) and - lists"
        multiline
        numberOfLines={compact ? 3 : 4}
        style={{ minHeight: compact ? 64 : 88, textAlignVertical: "top" }}
      />

      {showAttribution ? (
        <TextField
          label="Attribution"
          value={content.attribution ?? ""}
          onChangeText={(attribution) => onChange({ attribution })}
          placeholder="Who said it"
          hint={compact ? undefined : "Renders under the quote, in bold."}
        />
      ) : null}

      <Field label="Text alignment">
        <View className="flex-row gap-2">
          <LevelToggle
            label="Left"
            active={content.align === "left"}
            onPress={() => onChange({ align: "left" })}
          />
          <LevelToggle
            label="Centre"
            active={content.align === "center"}
            onPress={() => onChange({ align: "center" })}
          />
          <LevelToggle
            label="Follow the style"
            active={content.align === undefined}
            onPress={() => onChange({ align: undefined })}
          />
        </View>
      </Field>

      <TextField
        label="Button label"
        value={content.ctaLabel ?? ""}
        onChangeText={(ctaLabel) => onChange({ ctaLabel })}
        placeholder="Read more"
      />
      <TextField
        label="Button link"
        value={content.ctaUrl ?? ""}
        onChangeText={(ctaUrl) => onChange({ ctaUrl })}
        placeholder="https://…"
        autoCapitalize="none"
        keyboardType="url"
      />
      <Field label="Button style">
        <View className="flex-row flex-wrap gap-2">
          <LevelToggle
            label="Filled"
            active={content.ctaStyle === "filled"}
            onPress={() => onChange({ ctaStyle: "filled" })}
          />
          <LevelToggle
            label="Outline"
            active={content.ctaStyle === "outline"}
            onPress={() => onChange({ ctaStyle: "outline" })}
          />
          <LevelToggle
            label="Follow the style"
            active={content.ctaStyle === undefined}
            onPress={() => onChange({ ctaStyle: undefined })}
          />
        </View>
      </Field>
      {ctaProblem ? (
        <InlineWarning
          text={
            ctaProblem === "label-without-url"
              ? "This button has a label but no link — add one, or clear the label (a label of just a space still counts as one). A card can't save with only half a button."
              : "This button has a link but no label — nothing will be visible to click. Add a label, or clear the link."
          }
        />
      ) : null}
      {ctaUrlProblem ? (
        <InlineWarning text="A button link has to start with http://, https:// or mailto:. The campaign can't be saved until this one does." />
      ) : null}
    </View>
  );
}

/**
 * The image column's width, as a percentage of the card.
 *
 * A stepper rather than a slider: the app ships no slider primitive, a slider
 * on a phone can't reliably hit a specific number anyway, and the numbers
 * that matter here are specific — the newsletter's own rows are 44/56 and
 * 52/48, and it was forcing 50/50 that made the first rebuild read as
 * generic. So the presets are the real ones, and ± walks between them.
 *
 * Every path writes through `stepImageWidthPct`/the preset list, both of
 * which are inside the gate's 20-80 range, so this control cannot produce a
 * value that rejects the document.
 */
function ImageWidthControl({
  content,
  onChange,
}: {
  content: EmailCardContent;
  onChange: (patch: Partial<EmailCardContent>) => void;
}) {
  const pct = content.imageWidthPct ?? DEFAULT_IMAGE_WIDTH_PCT;
  const set = (next: number) => onChange({ imageWidthPct: next });

  return (
    <Field
      label="Image width"
      hint={`${pct}% image · ${100 - pct}% text`}
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <LevelToggle
          label="−"
          active={false}
          disabled={pct <= MIN_IMAGE_WIDTH_PCT}
          onPress={() => set(stepImageWidthPct(content.imageWidthPct, -IMAGE_WIDTH_PCT_STEP))}
        />
        <Text className="w-12 text-center text-base text-ink">{pct}%</Text>
        <LevelToggle
          label="+"
          active={false}
          disabled={pct >= MAX_IMAGE_WIDTH_PCT}
          onPress={() => set(stepImageWidthPct(content.imageWidthPct, IMAGE_WIDTH_PCT_STEP))}
        />
        <View className="w-2" />
        {IMAGE_WIDTH_PRESETS.map((preset) => (
          <LevelToggle
            key={preset.value}
            label={preset.label}
            active={pct === preset.value}
            onPress={() => set(preset.value)}
          />
        ))}
      </View>
    </Field>
  );
}

/** The three splits the newsletter actually uses, plus even. */
const IMAGE_WIDTH_PRESETS: readonly { value: number; label: string }[] = [
  { value: 33, label: "A third" },
  { value: 44, label: "44" },
  { value: 50, label: "Even" },
  { value: 52, label: "52" },
];

const ALT_EMPTY_WARNING =
  "No alt text. Screen readers and image-blocking clients (Gmail and Outlook block images by default) will show nothing here. Leave it empty only if the image is purely decorative.";

const ALT_MISSING_WARNING =
  "This image has no alt text field at all, which the campaign can't be saved with (every other block's edits go down with it). Type a description — or, if the image is purely decorative, tap into the field and back out to leave it deliberately empty.";

/**
 * A field-level advisory. Warn-toned rather than danger-toned on purpose:
 * every one of these describes something the designer can knowingly ship
 * (an intentionally decorative image), or is about to fix in the next
 * keystroke (a half-typed button). Red would cry wolf.
 */
export function InlineWarning({ text }: { text: string }) {
  return (
    <View className="mb-3 rounded-md border border-warn-soft bg-warn-bg px-2.5 py-2">
      <Text className="text-xs text-ink">{text}</Text>
    </View>
  );
}
