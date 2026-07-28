/**
 * One block in the designer's block stack — a drag handle, a kind-specific
 * editor, and a per-block toolbar (duplicate / delete). Selecting a card (tap
 * anywhere on it) gives it the light accent border + shows its toolbar,
 * mirroring `SiteMapEditor`'s "selection = contextual controls" idea, just
 * inline per-row instead of a floating bar (there's no canvas to float over
 * here — the stack IS the canvas).
 *
 * ── Editor idioms (kept identical across every kind) ───────────────────────
 * `TextField` for free text, `Select` for a closed set of >2 choices, the
 * `LevelToggle` segmented control for 2-3 choices, and — new with the
 * composed blocks — `CardContentEditor` for anything shaped like a card.
 * The shared controls live in `DesignerControls.tsx` so `CardContentEditor`
 * can use them without importing this file back.
 *
 * ── Where the composed editors keep their invariants ───────────────────────
 * `columns` and `poll` are the two kinds with COUNT bounds
 * (`MIN_COLUMNS`/`MAX_COLUMNS`, `MIN_POLL_OPTIONS`/`MAX_POLL_OPTIONS`), and
 * both enforce them by DISABLING the add/remove control at the bound rather
 * than letting the tap fail — the count is visible in the control's own
 * label, so the ceiling explains itself. Poll option ids come from
 * `newBlockId()` and are never touched again: a vote is recorded against the
 * id, so re-deriving one from a renamed label would silently re-bucket every
 * vote already cast.
 */
import { useRef } from "react";
import { View, Text, Pressable } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import {
  MAX_COLUMNS,
  MAX_POLL_OPTIONS,
  MIN_COLUMNS,
  MIN_POLL_OPTIONS,
  newBlockId,
  type EmailBlock,
  type EmailCardContent,
  type EmailPollOption,
} from "@events-os/shared";
import { Icon, TextField, Select, Field } from "../../ui";
import { MarkdownEditor } from "../../markdown";
import { colors } from "../../../lib/theme";
import {
  BLOCK_KIND_LABELS,
  imageUrlProblem,
  pollHasBlankLabel,
  syncListKeys,
} from "../../../lib/emailDesigner";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  EditorGroup,
  ImageUploadButton,
  LevelToggle,
  type UploadImage,
} from "./DesignerControls";
import { CardContentEditor, InlineWarning } from "./CardContentEditor";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";

const COMPACT_MARKDOWN_HEIGHT = 180;

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

export function BlockCard({
  block,
  selected,
  onSelect,
  onChange,
  onDuplicate,
  onDelete,
  drag,
  uploadImage,
  run,
}: {
  block: EmailBlock;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  drag?: GestureType;
  /** Image upload (see `ImageBlockEditor`); omitted → URL / library only. */
  uploadImage?: UploadImage;
  /** Surfaces an `uploadImage` failure via the screen's toast/Alert —
   *  required whenever `uploadImage` is passed (both come from the design
   *  screen together). */
  run?: ActionRunner["run"];
}) {
  return (
    <Pressable onPress={onSelect} accessibilityRole="button" accessibilityLabel={`${BLOCK_KIND_LABELS[block.kind]} block`}>
      <View
        className={`mb-3 rounded-lg border bg-raised p-3 ${
          selected ? "border-accent" : "border-border"
        }`}
        style={selected ? { borderWidth: 1.5 } : undefined}
      >
        <View className="mb-2 flex-row items-center gap-2">
          {drag ? (
            <GestureDetector gesture={drag}>
              <View hitSlop={6} className="cursor-grab rounded p-1 active:bg-sunken web:hover:bg-sunken">
                <Icon name="menu" size={15} color={colors.faint} />
              </View>
            </GestureDetector>
          ) : null}
          <Text className="flex-1 text-xs font-bold uppercase tracking-wider text-faint">
            {BLOCK_KIND_LABELS[block.kind]}
          </Text>
          <Pressable
            onPress={onDuplicate}
            hitSlop={6}
            accessibilityLabel="Duplicate block"
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="copy" size={14} color={colors.muted} />
          </Pressable>
          <Pressable
            onPress={onDelete}
            hitSlop={6}
            accessibilityLabel="Delete block"
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="trash-2" size={14} color={colors.danger} />
          </Pressable>
        </View>

        <BlockEditor block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
      </View>
    </Pressable>
  );
}

function BlockEditor({
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
  switch (block.kind) {
    case "heading":
      return (
        <View>
          <TextField
            value={block.text}
            onChangeText={(text) => onChange({ text })}
            placeholder="Heading text"
          />
          <View className="mt-2 flex-row gap-2">
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
        </View>
      );

    case "text":
      return (
        <MarkdownEditor
          value={block.markdown}
          onChange={(markdown) => onChange({ markdown })}
          minHeight={COMPACT_MARKDOWN_HEIGHT}
          placeholder="Write your message… supports **bold**, *italic*, links, and - lists"
        />
      );

    case "image":
      return (
        <ImageBlockEditor block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
      );

    case "button":
      return (
        <View>
          <TextField
            label="Button label"
            value={block.label}
            onChangeText={(label) => onChange({ label })}
            placeholder="Click here"
          />
          <TextField
            label="Link URL"
            value={block.url}
            onChangeText={(url) => onChange({ url })}
            placeholder="https://…"
            autoCapitalize="none"
            keyboardType="url"
          />
          <View className="mt-1 flex-row gap-2">
            <LevelToggle
              label="Left"
              active={(block.align ?? "left") === "left"}
              onPress={() => onChange({ align: "left" })}
            />
            <LevelToggle
              label="Center"
              active={block.align === "center"}
              onPress={() => onChange({ align: "center" })}
            />
          </View>
        </View>
      );

    case "divider":
      return <Text className="text-xs text-faint">A thin horizontal rule.</Text>;

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
      return <EyebrowEditor block={block} onChange={onChange} />;

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
        <ColumnsEditor block={block} onChange={onChange} uploadImage={uploadImage} run={run} />
      );

    case "quote":
      return (
        <View>
          <TextField
            label="Quote"
            value={block.text}
            onChangeText={(text) => onChange({ text })}
            placeholder="The line worth pulling out"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
          <TextField
            label="Attribution"
            value={block.attribution ?? ""}
            onChangeText={(attribution) => onChange({ attribution })}
            placeholder="Who said it (optional)"
          />
        </View>
      );

    case "poll":
      return <PollEditor block={block} onChange={onChange} />;

    default:
      return null;
  }
}

/** The all-caps accent label that opens a section, plus its leading glyph. */
function EyebrowEditor({
  block,
  onChange,
}: {
  block: Extract<EmailBlock, { kind: "eyebrow" }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const glyph = block.icon ?? "";
  return (
    <View>
      <TextField
        label="Eyebrow text"
        value={block.text}
        onChangeText={(text) => onChange({ text })}
        placeholder="THIS MONTH"
        autoCapitalize="characters"
        hint="Renders small, bold, and letter-spaced in the theme's accent colour."
      />
      <Field
        label="Glyph"
        hint="Any character works — these are just the ones the newsletter uses."
      >
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
        <View className="mt-2">
          <TextField
            value={glyph}
            onChangeText={(icon) => onChange({ icon: icon || undefined })}
            placeholder="…or paste your own"
            maxLength={4}
          />
        </View>
      </Field>
    </View>
  );
}

/**
 * 2-3 cards side by side. Each column is a `CardContentEditor` in `compact`
 * mode; the count controls sit in each column's header (remove) and below the
 * stack (add), both bounded by the contract's MIN/MAX.
 */
function ColumnsEditor({
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
  const columns = block.columns;
  const atMin = columns.length <= MIN_COLUMNS;
  const atMax = columns.length >= MAX_COLUMNS;

  /**
   * A stable React key PER POSITION, spliced in step with the edits below.
   *
   * Columns have no ids of their own in the contract, so the tempting key is
   * the index — and the index is wrong, because every column's remove button
   * is live once there are three of them and removal is a `filter`, i.e. from
   * the MIDDLE. Removing column 1 of 3 re-keys column 3's data onto the
   * subtree that was rendering column 2, which carries that subtree's
   * `useImageLibraryRegistration` ref (still pointing at column 2's uploaded
   * image) and its half-typed TextInput caret with it. Keys that travel with
   * the data make the removal a genuine unmount instead.
   *
   * A ref rather than state: this is derived bookkeeping, never rendered as
   * data, and it must be correct WITHIN the render that reads it. Lengths
   * that changed from outside this component (an undo, a reloaded document)
   * fall back to `syncListKeys`, where a remount is the worst case.
   */
  const keysRef = useRef<string[]>([]);
  if (keysRef.current.length !== columns.length) {
    keysRef.current = syncListKeys(keysRef.current, columns.length);
  }

  function patchColumn(index: number, patch: Partial<EmailCardContent>) {
    onChange({
      columns: columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  }

  function removeColumn(index: number) {
    // Drop the key with the column it belongs to, so the re-render's
    // length check is already satisfied and every SURVIVING column keeps the
    // key (and therefore the subtree) it had.
    keysRef.current = keysRef.current.filter((_, i) => i !== index);
    onChange({ columns: columns.filter((_, i) => i !== index) });
  }

  return (
    <View>
      {columns.map((column, index) => (
        <EditorGroup
          key={keysRef.current[index]}
          title={`Column ${index + 1}`}
          right={
            <Pressable
              onPress={atMin ? undefined : () => removeColumn(index)}
              disabled={atMin}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Remove column ${index + 1}`}
              className={`rounded p-1 ${atMin ? "opacity-30" : "active:bg-sunken web:hover:bg-sunken"}`}
            >
              <Icon name="x" size={13} color={colors.muted} />
            </Pressable>
          }
        >
          <CardContentEditor
            content={column}
            onChange={(patch) => patchColumn(index, patch)}
            compact
            uploadImage={uploadImage}
            run={run}
          />
        </EditorGroup>
      ))}
      <LevelToggle
        label={atMax ? `Maximum ${MAX_COLUMNS} columns` : "+ Add column"}
        active={false}
        disabled={atMax}
        onPress={() => onChange({ columns: [...columns, { heading: "" }] })}
      />
      <Text className="mt-2 text-2xs text-faint">
        Columns stack to full width on a phone.
      </Text>
    </View>
  );
}

/** Question + 2-6 options. Option ids are generated once and never rewritten. */
function PollEditor({
  block,
  onChange,
}: {
  block: Extract<EmailBlock, { kind: "poll" }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const options = block.options;
  const atMin = options.length <= MIN_POLL_OPTIONS;
  const atMax = options.length >= MAX_POLL_OPTIONS;
  // The write gate's own test (`length === 0`, untrimmed) — see
  // `pollHasBlankLabel`. Warning on a whitespace-only label would flag a poll
  // that saves perfectly well.
  const blankLabel = pollHasBlankLabel(options);

  function setOptions(next: EmailPollOption[]) {
    onChange({ options: next });
  }

  return (
    <View>
      <TextField
        label="Question"
        value={block.question}
        onChangeText={(question) => onChange({ question })}
        placeholder="What should we sing next month?"
      />
      <Field label="Options">
        {options.map((option, index) => (
          <View key={option.id} className="mb-2 flex-row items-center gap-2">
            <View className="flex-1">
              <TextField
                value={option.label}
                onChangeText={(label) =>
                  // Patch the LABEL only — `option.id` is carried through
                  // untouched. Votes are tallied by id, so regenerating one
                  // on a rename would orphan every vote already cast for it.
                  setOptions(
                    options.map((o, i) => (i === index ? { ...o, label } : o)),
                  )
                }
                placeholder={`Option ${index + 1}`}
              />
            </View>
            <Pressable
              onPress={
                atMin ? undefined : () => setOptions(options.filter((_, i) => i !== index))
              }
              disabled={atMin}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Remove option ${index + 1}`}
              className={`mb-3 rounded p-1 ${atMin ? "opacity-30" : "active:bg-sunken web:hover:bg-sunken"}`}
            >
              <Icon name="x" size={13} color={colors.muted} />
            </Pressable>
          </View>
        ))}
        <LevelToggle
          label={atMax ? `Maximum ${MAX_POLL_OPTIONS} options` : "+ Add option"}
          active={false}
          disabled={atMax}
          onPress={() => setOptions([...options, { id: newBlockId(), label: "" }])}
        />
      </Field>
      {blankLabel ? (
        <InlineWarning text="Every option needs a label before this campaign can be saved." />
      ) : null}
      <Text className="text-2xs text-faint">
        Recipients vote by tapping an option; the tallies show on the campaign
        once it has sent.
      </Text>
    </View>
  );
}

function ImageBlockEditor({
  block,
  onChange,
  uploadImage,
  run,
}: {
  block: Extract<EmailBlock, { kind: "image" }>;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: UploadImage;
  run?: ActionRunner["run"];
}) {
  const library = useImageLibraryRegistration();
  // The URL is the field that decides whether this document can be SAVED at
  // all: `defaultBlockFor("image")` starts it empty, and the write gate
  // rejects the whole document over it — so an unfilled image block silently
  // takes every other block's edits down with it until it's dealt with.
  const urlProblem = imageUrlProblem(block.url);

  return (
    <View>
      <TextField
        label="Image URL"
        value={block.url}
        onChangeText={(url) => {
          onChange({ url });
          // A typed/pasted URL is not the image this editor uploaded, so any
          // alt text written next must not be backfilled onto that row.
          library.forget();
        }}
        placeholder="https://…"
        autoCapitalize="none"
        keyboardType="url"
      />
      {urlProblem === "missing" ? (
        <InlineWarning text="This image has no URL yet. Upload a picture or choose one from the library — the campaign can't be saved (including edits to every other block) until this is filled in." />
      ) : urlProblem === "scheme" ? (
        <InlineWarning text="An image URL has to start with http:// or https://. The campaign can't be saved until this one does." />
      ) : null}
      <View className="mb-1 flex-row flex-wrap items-start gap-2">
        {uploadImage && run ? (
          <ImageUploadButton
            uploadImage={uploadImage}
            run={run}
            onUploaded={(uploaded, suggestedLabel) => {
              onChange({ url: uploaded.url });
              library.register(uploaded.storageId, suggestedLabel || "Campaign image");
            }}
          />
        ) : null}
        {/* Picking from the library fills the alt text too — the description
            was written once, the first time this image was used. `forget()`
            because the picked row already HAS its description; editing the
            alt field from here must not overwrite the row this editor's own
            upload created (a different image entirely). */}
        <ImageLibraryPicker
          onPick={({ url, alt }) => {
            onChange({ url, alt });
            library.forget();
          }}
        />
      </View>
      <TextField
        label="Alt text"
        value={block.alt}
        onChangeText={(alt) => {
          onChange({ alt });
          library.noteAlt(alt);
        }}
        placeholder="Describes the image for screen readers / blocked images"
      />
      {/* Advisory only, and deliberately SECOND: the write gate accepts an
          empty alt ("" is the contract's "decorative"), so this must never be
          the loudest thing on the card while the url — which the gate does
          reject — is still unfilled. With no url there's no image to describe
          yet, so it stays quiet. */}
      {urlProblem === null && block.alt.trim() === "" ? (
        <InlineWarning text="No alt text. Screen readers and image-blocking clients will show nothing here. Leave it empty only if the image is purely decorative." />
      ) : null}
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
}
