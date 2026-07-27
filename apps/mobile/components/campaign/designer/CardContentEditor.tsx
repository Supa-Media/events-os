/**
 * The editor for ONE `EmailCardContent` — image, heading, body, call to
 * action.
 *
 * Written once and used twice, exactly as the shared shape intends: the
 * full-width `card` block edits a single one of these, and the `columns`
 * block edits 2-3 of them side by side. `emailBlocks.ts` calls this out as
 * the reason `EmailCardContent` exists at all ("the renderer, the validator,
 * and the composer editor are each written once"), so duplicating this per
 * block kind would defeat the contract's whole point.
 *
 * ── The two validation rules live HERE, inline ─────────────────────────────
 * `validateEmailDocument` rejects a card whose `imageAlt` is missing while
 * `imageUrl` is set, and one where exactly one of `ctaLabel`/`ctaUrl` is
 * filled. Both are easy to hit by accident and both fail at SAVE time,
 * server-side, long after the mistake — so each is mirrored as a field-level
 * hint the moment it's true. The hints are advisory-looking (they don't
 * block typing) but they name the exact fix.
 *
 * Choosing an image ALWAYS writes `imageAlt` alongside `imageUrl` (as `""`
 * when there's nothing better), because "" is the contract's legitimate
 * "decorative" value and `undefined` is the one that makes the document
 * unsaveable. The empty-alt warning then nags visibly rather than silently
 * breaking autosave.
 */
import { Text, View } from "react-native";
import type { EmailCardContent } from "@events-os/shared";
import { TextField } from "../../ui";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";
import { ImageUploadButton, type UploadImage } from "./DesignerControls";
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
  const altMissing = hasImage && !content.imageAlt;
  const hasLabel = !!content.ctaLabel?.trim();
  const hasUrl = !!content.ctaUrl?.trim();
  const ctaHalfFilled = hasLabel !== hasUrl;

  return (
    <View>
      <TextField
        label={compact ? "Image URL" : "Image"}
        value={content.imageUrl ?? ""}
        onChangeText={(imageUrl) =>
          onChange(
            imageUrl.trim()
              ? { imageUrl, imageAlt: content.imageAlt ?? "" }
              : // Clearing the URL clears the alt with it — an alt string
                // hanging off an imageless card is dead data that reappears
                // confusingly the next time an image is chosen.
                { imageUrl: undefined, imageAlt: undefined },
          )
        }
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
          onPick={({ url, alt }) => onChange({ imageUrl: url, imageAlt: alt })}
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
            altMissing
              ? undefined
              : "Read aloud by screen readers, and shown in place of the image when a client blocks it."
          }
        />
      ) : null}
      {altMissing ? <InlineWarning text={ALT_WARNING} /> : null}

      <TextField
        label="Heading"
        value={content.heading ?? ""}
        onChangeText={(heading) => onChange({ heading })}
        placeholder={compact ? "Column heading" : "Card heading"}
      />

      <TextField
        label="Body"
        value={content.body ?? ""}
        onChangeText={(body) => onChange({ body })}
        placeholder="Supports **bold**, *italic*, [links](https://…) and - lists"
        multiline
        numberOfLines={compact ? 3 : 4}
        style={{ minHeight: compact ? 64 : 88, textAlignVertical: "top" }}
      />

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
      {ctaHalfFilled ? (
        <InlineWarning
          text={
            hasLabel
              ? "This button has a label but no link — add one, or clear the label. A card can't save with only half a button."
              : "This button has a link but no label — nothing will be visible to click. Add a label, or clear the link."
          }
        />
      ) : null}
    </View>
  );
}

const ALT_WARNING =
  "No alt text. Screen readers and image-blocking clients (Gmail and Outlook block images by default) will show nothing here. Leave it empty only if the image is purely decorative.";

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
