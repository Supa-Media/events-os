/**
 * The PROPERTIES of one `EmailCardContent` — how the card is painted, where
 * its image sits, and where its call to action points.
 *
 * Written once and used twice, exactly as the shared shape intends: the
 * full-width `card` block edits a single one of these, and the `columns`
 * block edits 2-3 of them side by side. `emailBlocks.ts` calls this out as
 * the reason `EmailCardContent` exists at all ("the renderer, the validator,
 * and the composer editor are each written once"), so duplicating this per
 * block kind would defeat the contract's whole point.
 *
 * ── COPY is not edited here ────────────────────────────────────────────────
 * The heading, eyebrow, body, attribution and button LABEL all edit in place
 * on the canvas, where they appear (`canvas/BlockView.tsx`). What is left here
 * is what a canvas can't yet express: the variant, the image's address and
 * description, where the image sits, how wide its column is, the text
 * alignment, and the button's destination. Duplicating a text field here would
 * put back the form the canvas replaced.
 *
 * ── The fields follow the variant ──────────────────────────────────────────
 * The layout-dependent fields appear only where they DO something: the image
 * side and its column width need an image, and the width needs the image to be
 * beside the text rather than above it.
 *
 * ── The validation rules are mirrored, but rendered elsewhere ──────────────
 * `validateEmailDocument` rejects a card whose `imageAlt` is missing while
 * `imageUrl` is set, one where exactly one of `ctaLabel`/`ctaUrl` is filled,
 * and one whose `ctaUrl` carries a scheme outside http/https/mailto. All three
 * are easy to hit by accident and all fail at SAVE time, server-side, long
 * after the mistake. The predicates that mirror them live in
 * `lib/emailDesigner.ts` (pinned against the real validator in a unit test);
 * `canvas/blockWarnings.ts` turns them into the warnings the block badge
 * counts and the inspector spells out, above these controls.
 *
 * Choosing an image ALWAYS writes `imageAlt` alongside `imageUrl` (as `""`
 * when there's nothing better), because "" is the contract's legitimate
 * "decorative" value and `undefined` is the one that makes the document
 * unsaveable — so the empty-alt case is a visible advisory rather than a
 * silently broken autosave.
 */
import { Text, View } from "react-native";
import type { EmailCardContent } from "@events-os/shared";
import { Field } from "../../ui";
import {
  CARD_VARIANT_OPTIONS,
  DEFAULT_IMAGE_WIDTH_PCT,
  IMAGE_WIDTH_PCT_STEP,
  MAX_IMAGE_WIDTH_PCT,
  MIN_IMAGE_WIDTH_PCT,
  imageAltProblem,
  stepImageWidthPct,
} from "../../../lib/emailDesigner";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";
// `TextField`/`Select` are the DESIGNER's read-only-aware wrappers around the
// UI kit's own — see `DesignerControls`' read-only doc. Importing the kit's
// versions directly here is what let a locked campaign render typable fields.
import {
  ImageUploadButton,
  LevelToggle,
  Select,
  TextField,
  useDesignerReadOnly,
  type UploadImage,
} from "./DesignerControls";
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
  // earns an advisory. Only used here to drop the field's hint when the
  // inspector is already saying something louder about it.
  const altProblem = imageAltProblem({ url: content.imageUrl, alt: content.imageAlt });

  const variant = content.variant ?? "plain";
  const imageSide = content.imageSide ?? "top";
  const beside = hasImage && (imageSide === "left" || imageSide === "right");

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
              library.register(uploaded.storageId, suggestedLabel || "Email image");
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
        label="Button link"
        value={content.ctaUrl ?? ""}
        onChangeText={(ctaUrl) => onChange({ ctaUrl })}
        placeholder="https://…"
        hint="The button's LABEL is typed on the card itself. Both halves are needed — a card can't save with only one."
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
