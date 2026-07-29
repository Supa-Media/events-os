/**
 * THE SELECTED BLOCK'S PROPERTIES — everything about a block that isn't text
 * you can simply click and type on the canvas.
 *
 * Mined out of the old `BlockCard.tsx`, which put ALL of this in a stack of
 * fifteen form cards that WAS the document. Here the document is the canvas
 * and this panel holds only what a canvas can't express yet:
 *
 *   - addresses (image URLs, links) — a URL has no visual form;
 *   - alt text — invisible by definition, and a save-blocker when missing;
 *   - closed choices (card variant, image placement, spacer height, alignment);
 *   - counts (columns, poll options, footer links) with their contract bounds.
 *
 * Copy — headings, body, button labels, eyebrows, poll option labels, the
 * footer's nav line — is deliberately NOT here. It is edited in place, where
 * it appears. Anything that moved to the canvas and is still duplicated here
 * is a form the canvas was supposed to replace.
 *
 * ── Warnings are NOT rendered here ─────────────────────────────────────────
 * Every inline warning this file used to carry now comes from
 * `blockWarnings.ts` and is rendered ONCE, by the inspector, above these
 * controls. The predicates are unchanged and still pinned against the real
 * validator in `lib/emailDesigner.test.ts`; only where they are SHOWN changed.
 */
import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import {
  MAX_COLUMNS,
  MAX_POLL_OPTIONS,
  MIN_COLUMNS,
  MIN_POLL_OPTIONS,
  newBlockId,
  type EmailBlock,
  type EmailCardContent,
} from "@events-os/shared";
import { Field, Icon } from "../../../ui";
import { MarkdownEditor } from "../../../markdown";
import { colors } from "../../../../lib/theme";
import { MAX_FOOTER_LINKS, syncListKeys } from "../../../../lib/emailDesigner";
import type { ActionRunner } from "../../../../lib/useActionToast";
import {
  EditorGroup,
  ImageUploadButton,
  LevelToggle,
  Select,
  TextField,
  useDesignerReadOnly,
  type UploadImage,
} from "../DesignerControls";
import { CardContentEditor } from "../CardContentEditor";
import { ImageLibraryPicker, useImageLibraryRegistration } from "../ImageLibraryPicker";
import { buttonAlign } from "./canvasStyles";

const MARKDOWN_HEIGHT = 220;

/**
 * The glyphs offered as one-tap suggestions on an `eyebrow`.
 *
 * Literal characters, never icon-font names: email clients don't load icon
 * fonts, so anything else renders as a tofu box (the contract says as much).
 * The four typographic marks are what the Public Worship newsletter actually
 * uses to open a section; the two emoji are there because the designer asked
 * for "something seasonal" and emoji are the only glyphs with colour that
 * survive every client.
 */
const EYEBROW_GLYPHS = ["◆", "★", "✦", "❯", "🎵", "✨"] as const;

export function BlockFields({
  block,
  onChange,
  uploadImage,
  run,
}: {
  block: EmailBlock;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  const readOnly = useDesignerReadOnly();

  switch (block.kind) {
    case "heading":
      return (
        <Field label="Size" hint="The text itself edits on the canvas.">
          <View className="flex-row gap-2">
            <LevelToggle
              label="H1 (large)"
              active={(block.level ?? 1) === 1}
              onPress={() => onChange({ level: 1 })}
            />
            <LevelToggle
              label="H2 (small)"
              active={block.level === 2}
              onPress={() => onChange({ level: 2 })}
            />
          </View>
        </Field>
      );

    case "text":
      // The canvas edits raw markdown in place; this is the roomier surface
      // for real copy — CodeMirror with live preview, which conceals the
      // syntax on inactive lines.
      return (
        <Field
          label="Body"
          hint="Supports **bold**, *italic*, [links](https://…) and - lists."
        >
          <MarkdownEditor
            value={block.markdown}
            onChange={(markdown) => onChange({ markdown })}
            minHeight={MARKDOWN_HEIGHT}
            editable={!readOnly}
            placeholder={readOnly ? undefined : "Write your message…"}
          />
        </Field>
      );

    case "image":
      return (
        <View>
          <ImageSourceFields
            urlLabel="Image URL"
            url={block.url}
            alt={block.alt}
            alwaysShowAlt
            onChange={({ url, alt }) => onChange({ url: url ?? "", alt: alt ?? "" })}
            uploadImage={uploadImage}
            run={run}
          />
          <TextField
            label="Link (optional)"
            value={block.href ?? ""}
            onChangeText={(href) => onChange({ href: href.trim() ? href : undefined })}
            placeholder="https://… — makes the image tappable"
            autoCapitalize="none"
            keyboardType="url"
          />
          <Field label="Width">
            <View className="flex-row gap-2">
              <LevelToggle
                label="Full width"
                active={(block.width ?? "full") === "full"}
                onPress={() => onChange({ width: "full" })}
              />
              <LevelToggle
                label="Half width"
                active={block.width === "half"}
                onPress={() => onChange({ width: "half" })}
              />
            </View>
          </Field>
        </View>
      );

    case "bleed_image": {
      const empty = (block.url ?? "").length === 0;
      return (
        <View>
          <Text className="mb-2 text-2xs text-faint">
            Runs edge to edge by default, with no padding around it. In this design
            the banner IS the section heading — it carries the words as artwork, so
            it replaces a text heading rather than sitting above one.
          </Text>
          <ImageSourceFields
            urlLabel="Banner image"
            urlHint={
              empty
                ? "Empty is fine — the banner renders as a plain placeholder band until you choose the artwork."
                : undefined
            }
            altHint="The banner carries the heading, so this is what a screen reader — and anyone whose client blocks images — gets instead of it. Write out the words on it."
            url={block.url}
            alt={block.alt}
            clearsToUndefined
            alwaysShowAlt
            onChange={({ url, alt }) => onChange({ url, alt: alt ?? "" })}
            uploadImage={uploadImage}
            run={run}
            libraryLabel="Newsletter banner"
          />
          <TextField
            label="Link (optional)"
            value={block.href ?? ""}
            onChangeText={(href) => onChange({ href: href.trim() ? href : undefined })}
            placeholder="https://… — makes the banner tappable"
            autoCapitalize="none"
            keyboardType="url"
          />
          <Field label="Width">
            <View className="flex-row gap-2">
              <LevelToggle
                label="Edge to edge"
                active={!block.inset}
                onPress={() => onChange({ inset: undefined })}
              />
              <LevelToggle
                label="Inset"
                active={block.inset === true}
                onPress={() => onChange({ inset: true })}
              />
            </View>
          </Field>
        </View>
      );
    }

    case "button":
      return (
        <View>
          <TextField
            label="Link URL"
            value={block.url}
            onChangeText={(url) => onChange({ url })}
            placeholder="https://…"
            hint="The label itself edits on the canvas."
            autoCapitalize="none"
            keyboardType="url"
          />
          {/* A button with no `align` sends CENTRED (`renderButtonBlock`),
              and `defaultBlockFor` sets none — so asserting "Left" here was
              the inspector telling the designer the opposite of what she was
              about to send. The default comes from the geometry table, so the
              canvas, the inspector and the renderer cannot disagree. */}
          <Field label="Alignment">
            <View className="flex-row gap-2">
              <LevelToggle
                label="Left"
                active={buttonAlign(block.align) === "left"}
                onPress={() => onChange({ align: "left" })}
              />
              <LevelToggle
                label="Center"
                active={buttonAlign(block.align) === "center"}
                onPress={() => onChange({ align: "center" })}
              />
            </View>
          </Field>
          <Field label="Style">
            <View className="flex-row gap-2">
              <LevelToggle
                label="Filled"
                active={(block.variant ?? "filled") === "filled"}
                onPress={() => onChange({ variant: "filled" })}
              />
              <LevelToggle
                label="Outline"
                active={block.variant === "outline"}
                onPress={() => onChange({ variant: "outline" })}
              />
            </View>
          </Field>
        </View>
      );

    case "divider":
      return (
        <Text className="text-xs text-faint">
          A thin horizontal rule in the theme&apos;s border colour. Nothing to set.
        </Text>
      );

    case "hairline":
      return (
        <Text className="text-xs text-faint">
          A thin full-width rule in the theme&apos;s hairline colour — the gap
          between two sections, not a border inside a card.
        </Text>
      );

    case "spacer":
      return (
        <Select
          label="Height"
          value={block.size}
          options={[
            { value: "sm", label: "Small" },
            { value: "md", label: "Medium" },
            { value: "lg", label: "Large" },
          ]}
          onChange={(size) => onChange({ size })}
        />
      );

    case "eyebrow":
      return <EyebrowFields block={block} onChange={onChange} />;

    case "quote":
      return (
        <Text className="text-xs text-faint">
          The quote and its attribution edit on the canvas — click the words.
        </Text>
      );

    case "card":
      return (
        <CardContentEditor
          content={block}
          onChange={onChange}
          uploadImage={uploadImage}
          run={run}
        />
      );

    case "columns":
      return (
        <ColumnsFields block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
      );

    case "poll":
      return <PollFields block={block} onChange={onChange} />;

    case "footer":
      return (
        <FooterFields block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
      );

    default:
      return null;
  }
}

/** The glyph that opens an eyebrow. The TEXT is edited on the canvas. */
function EyebrowFields({
  block,
  onChange,
}: {
  block: Extract<EmailBlock, { kind: "eyebrow" }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const readOnly = useDesignerReadOnly();
  const glyph = block.icon ?? "";
  return (
    <Field
      label="Glyph"
      hint={
        readOnly ? undefined : "Any character works — these are just the ones the newsletter uses."
      }
    >
      {readOnly ? null : (
        <View className="flex-row flex-wrap items-center gap-2">
          {EYEBROW_GLYPHS.map((g) => (
            <Pressable
              key={g}
              onPress={() => onChange({ icon: glyph === g ? undefined : g })}
              accessibilityRole="button"
              accessibilityLabel={`Use the ${g} glyph`}
              accessibilityState={{ selected: glyph === g }}
              className={`h-9 w-9 items-center justify-center rounded-md border ${
                glyph === g ? "border-accent bg-accent-soft" : "border-border bg-raised"
              }`}
            >
              <Text className="text-base text-ink">{g}</Text>
            </Pressable>
          ))}
          <LevelToggle
            label="None"
            active={glyph === ""}
            onPress={() => onChange({ icon: undefined })}
          />
        </View>
      )}
      <View className={readOnly ? undefined : "mt-2"}>
        <TextField
          value={glyph}
          onChangeText={(icon) => onChange({ icon: icon || undefined })}
          placeholder="…or paste your own"
          maxLength={4}
        />
      </View>
    </Field>
  );
}

/**
 * 2-3 cards side by side. Each column's PROPERTIES are a `CardContentEditor`
 * in compact mode; its copy is edited on the canvas like any other card. The
 * count controls sit in each column's header (remove) and below the stack
 * (add), both bounded by the contract's MIN/MAX rather than failing on tap.
 */
function ColumnsFields({
  block,
  onChange,
  uploadImage,
  run,
}: {
  block: Extract<EmailBlock, { kind: "columns" }>;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  const readOnly = useDesignerReadOnly();
  const columns = block.columns;
  const atMin = columns.length <= MIN_COLUMNS;
  const atMax = columns.length >= MAX_COLUMNS;

  /**
   * A stable React key PER POSITION, spliced in step with the edits below.
   *
   * Columns have no ids of their own in the contract, so the tempting key is
   * the index — and the index is wrong, because removal is a `filter`, i.e.
   * from the MIDDLE. Removing column 1 of 3 re-keys column 3's data onto the
   * subtree that was rendering column 2, which carries that subtree's
   * `useImageLibraryRegistration` ref (still pointing at column 2's uploaded
   * image) and its half-typed TextInput caret with it.
   */
  const keysRef = useRef<string[]>([]);
  if (keysRef.current.length !== columns.length) {
    keysRef.current = syncListKeys(keysRef.current, columns.length);
  }

  return (
    <View>
      {columns.map((column, index) => (
        <EditorGroup
          key={keysRef.current[index]}
          title={`Column ${index + 1}`}
          right={
            readOnly ? undefined : (
              <Pressable
                onPress={
                  atMin
                    ? undefined
                    : () => {
                        keysRef.current = keysRef.current.filter((_, i) => i !== index);
                        onChange({ columns: columns.filter((_, i) => i !== index) });
                      }
                }
                disabled={atMin}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove column ${index + 1}`}
                className={`rounded p-1 ${atMin ? "opacity-30" : "active:bg-sunken web:hover:bg-sunken"}`}
              >
                <Icon name="x" size={13} color={colors.muted} />
              </Pressable>
            )
          }
        >
          <CardContentEditor
            content={column}
            onChange={(patch: Partial<EmailCardContent>) =>
              onChange({
                columns: columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
              })
            }
            compact
            uploadImage={uploadImage}
            run={run}
          />
        </EditorGroup>
      ))}
      {readOnly ? null : (
        <LevelToggle
          label={atMax ? `Maximum ${MAX_COLUMNS} columns` : "+ Add column"}
          active={false}
          disabled={atMax}
          onPress={() => onChange({ columns: [...columns, { heading: "" }] })}
        />
      )}
      <Text className="mt-2 text-2xs text-faint">
        Columns stack to full width on a phone.
      </Text>
    </View>
  );
}

/** Option COUNT. Option labels are edited on the canvas, on the pills
 *  themselves. Ids are generated once and never rewritten — a vote is tallied
 *  by id, so re-deriving one from a renamed label would orphan every vote
 *  already cast. */
function PollFields({
  block,
  onChange,
}: {
  block: Extract<EmailBlock, { kind: "poll" }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const readOnly = useDesignerReadOnly();
  const options = block.options;
  const atMin = options.length <= MIN_POLL_OPTIONS;
  const atMax = options.length >= MAX_POLL_OPTIONS;

  return (
    <View>
      <Field label="Options" hint="The labels edit on the canvas.">
        {options.map((option, index) => (
          <View key={option.id} className="mb-2 flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
              {option.label || `Option ${index + 1}`}
            </Text>
            {readOnly ? null : (
              <Pressable
                onPress={
                  atMin
                    ? undefined
                    : () => onChange({ options: options.filter((_, i) => i !== index) })
                }
                disabled={atMin}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove option ${index + 1}`}
                className={`rounded p-1 ${atMin ? "opacity-30" : "active:bg-sunken web:hover:bg-sunken"}`}
              >
                <Icon name="x" size={13} color={colors.muted} />
              </Pressable>
            )}
          </View>
        ))}
        {readOnly ? null : (
          <LevelToggle
            label={atMax ? `Maximum ${MAX_POLL_OPTIONS} options` : "+ Add option"}
            active={false}
            disabled={atMax}
            onPress={() => onChange({ options: [...options, { id: newBlockId(), label: "" }] })}
          />
        )}
      </Field>
      <Text className="text-2xs text-faint">
        Recipients vote by tapping an option; the tallies show on the email once
        it has sent.
      </Text>
    </View>
  );
}

/**
 * The sign-off block: logo and the social/link row. The nav line is edited on
 * the canvas.
 *
 * The unsubscribe line is NOT edited here and never will be: `emailRender.ts`
 * appends it to every footer from the send's own unsubscribe URL, because a
 * send that can lose its unsubscribe link to an editing mistake is a legal
 * problem, not a design one.
 */
function FooterFields({
  block,
  onChange,
  uploadImage,
  run,
}: {
  block: Extract<EmailBlock, { kind: "footer" }>;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  const readOnly = useDesignerReadOnly();
  const links = block.links ?? [];
  const atMax = links.length >= MAX_FOOTER_LINKS;

  function setLinks(next: { label: string; url: string }[]) {
    onChange({ links: next });
  }

  return (
    <View>
      <ImageSourceFields
        urlLabel="Logo (optional)"
        altLabel="Logo alt text"
        url={block.logoUrl}
        alt={block.logoAlt}
        // Absent is fine; EMPTY is not — the gate rejects `logoUrl: ""`, so
        // clearing the field removes the key instead of blanking it.
        clearsToUndefined
        onChange={({ url, alt }) => onChange({ logoUrl: url, logoAlt: alt })}
        uploadImage={uploadImage}
        run={run}
        libraryLabel="Footer logo"
      />
      <Field
        label="Links"
        hint={
          links.length === 0
            ? "Socials, a giving page, view-in-browser — they render as one centred row."
            : undefined
        }
      >
        {links.map((link, index) => (
          <View key={`link-${index}`} className="mb-2 flex-row items-start gap-2">
            <View className="flex-1">
              <TextField
                value={link.label}
                onChangeText={(label) =>
                  setLinks(links.map((l, i) => (i === index ? { ...l, label } : l)))
                }
                placeholder="Label"
              />
            </View>
            <View className="flex-1">
              <TextField
                value={link.url}
                onChangeText={(url) =>
                  setLinks(links.map((l, i) => (i === index ? { ...l, url } : l)))
                }
                placeholder="https://…"
                autoCapitalize="none"
                keyboardType="url"
              />
            </View>
            {readOnly ? null : (
              <Pressable
                onPress={() => setLinks(links.filter((_, i) => i !== index))}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove link ${index + 1}`}
                className="mb-3 rounded p-1 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="x" size={13} color={colors.muted} />
              </Pressable>
            )}
          </View>
        ))}
        {readOnly ? null : (
          <LevelToggle
            label={atMax ? `Maximum ${MAX_FOOTER_LINKS} links` : "+ Add link"}
            active={false}
            disabled={atMax}
            // A fresh row starts with a real label and the https:// stub, so
            // adding one doesn't itself make the document unsaveable — the
            // same choice `defaultBlockFor("button")` makes.
            onPress={() => setLinks([...links, { label: "Instagram", url: "https://" }])}
          />
        )}
      </Field>
      <Text className="text-2xs text-faint">
        The unsubscribe line is added automatically to every send — it can&apos;t
        be edited or removed here.
      </Text>
    </View>
  );
}

/**
 * The url + upload + library + alt-text quartet, shared by the `image` block,
 * the `bleed_image` banner, and the `footer` logo.
 *
 * One component because all three carry the SAME two write-gate rules — the
 * url must be a non-empty http(s) string, and an alt must exist beside it —
 * and the same accessibility argument for the library: picking a reused image
 * brings its description with it, so the alt text is written once, properly.
 *
 * `clearsToUndefined` is the one real difference. A footer's logo is optional,
 * so clearing it writes `undefined` for BOTH halves — the field is removed
 * rather than emptied, because `logoUrl: ""` is a rejection while an absent
 * logo is fine.
 */
function ImageSourceFields({
  urlLabel,
  urlPlaceholder = "https://…",
  urlHint,
  altLabel = "Alt text",
  altHint,
  url,
  alt,
  clearsToUndefined = false,
  alwaysShowAlt = false,
  onChange,
  uploadImage,
  run,
  libraryLabel = "Email image",
}: {
  urlLabel: string;
  urlPlaceholder?: string;
  urlHint?: string;
  altLabel?: string;
  altHint?: string;
  url: string | undefined;
  alt: string | undefined;
  clearsToUndefined?: boolean;
  /** Keep the alt field visible even with no url — the banner's alt IS the
   *  section heading, so it's worth writing before the artwork arrives. */
  alwaysShowAlt?: boolean;
  /** Both halves at once — an alt is ALWAYS written alongside a url, because
   *  `undefined` is the value that makes the document unsaveable while `""`
   *  is the contract's legitimate "decorative". */
  onChange: (next: { url: string | undefined; alt: string | undefined }) => void;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
  libraryLabel?: string;
}) {
  const library = useImageLibraryRegistration();
  const hasUrl = typeof url === "string" && url.length > 0;

  return (
    <View>
      <TextField
        label={urlLabel}
        value={url ?? ""}
        onChangeText={(next) => {
          onChange(
            clearsToUndefined && next.trim() === ""
              ? { url: undefined, alt: undefined }
              : { url: next, alt: alt ?? "" },
          );
          // A typed/pasted URL is not the image this editor uploaded, so any
          // alt text written next must not be backfilled onto that row.
          library.forget();
        }}
        placeholder={urlPlaceholder}
        hint={urlHint}
        autoCapitalize="none"
        keyboardType="url"
      />
      <View className="mb-1 flex-row flex-wrap items-start gap-2">
        {uploadImage && run ? (
          <ImageUploadButton
            uploadImage={uploadImage}
            run={run}
            onUploaded={(uploaded, suggestedLabel) => {
              onChange({ url: uploaded.url, alt: alt ?? "" });
              library.register(uploaded.storageId, suggestedLabel || libraryLabel);
            }}
          />
        ) : null}
        {/* Picking from the library fills the alt text too — the description
            was written once, the first time this image was used. `forget()`
            because the picked row already HAS its description; editing the alt
            field from here must not overwrite the row this editor's own upload
            created (a different image entirely). */}
        <ImageLibraryPicker
          onPick={({ url: picked, alt: pickedAlt }) => {
            onChange({ url: picked, alt: pickedAlt });
            library.forget();
          }}
        />
      </View>
      {alwaysShowAlt || hasUrl ? (
        <TextField
          label={altLabel}
          hint={altHint}
          value={alt ?? ""}
          onChangeText={(next) => {
            onChange({ url, alt: next });
            // Backfills the library row this editor just created, so the
            // description is written once and reused forever after.
            library.noteAlt(next);
          }}
          placeholder="Describes the image for screen readers / blocked images"
        />
      ) : null}
    </View>
  );
}
