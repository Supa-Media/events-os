/**
 * One block in the designer's block stack — a drag handle, a kind-specific
 * editor, and a per-block toolbar (duplicate / delete). Selecting a card (tap
 * anywhere on it) gives it the light accent border + shows its toolbar,
 * mirroring `SiteMapEditor`'s "selection = contextual controls" idea, just
 * inline per-row instead of a floating bar (there's no canvas to float over
 * here — the stack IS the canvas).
 */
import { useState } from "react";
import { ActivityIndicator, Platform, View, Text, Pressable } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only used on native, mirroring `CoverPhotoPicker`'s upload flow.
import * as ImagePicker from "expo-image-picker";
import type { EmailBlock } from "@events-os/shared";
import { Icon, TextField, Select, Field } from "../../ui";
import { MarkdownEditor } from "../../markdown";
import { colors } from "../../../lib/theme";
import { BLOCK_KIND_LABELS } from "../../../lib/emailDesigner";

const COMPACT_MARKDOWN_HEIGHT = 180;

export function BlockCard({
  block,
  selected,
  onSelect,
  onChange,
  onDuplicate,
  onDelete,
  drag,
  uploadImage,
}: {
  block: EmailBlock;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  drag?: GestureType;
  /** Web-only image upload (see `ImageBlockEditor`); omitted → URL-only. */
  uploadImage?: (file: Blob, contentType: string) => Promise<string>;
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

        <BlockEditor block={block} onChange={onChange} uploadImage={uploadImage} />
      </View>
    </Pressable>
  );
}

function BlockEditor({
  block,
  onChange,
  uploadImage,
}: {
  block: EmailBlock;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: (file: Blob, contentType: string) => Promise<string>;
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
      return <ImageBlockEditor block={block} onChange={onChange} uploadImage={uploadImage} />;

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

    default:
      return null;
  }
}

/** A small two-state toggle button — reused for heading level, button align. */
function LevelToggle({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-md border px-2.5 py-1 ${
        active ? "border-accent bg-accent-soft" : "border-border bg-raised"
      }`}
    >
      <Text className={`text-xs font-medium ${active ? "font-semibold text-accent" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function ImageBlockEditor({
  block,
  onChange,
  uploadImage,
}: {
  block: Extract<EmailBlock, { kind: "image" }>;
  onChange: (patch: Record<string, unknown>) => void;
  uploadImage?: (file: Blob, contentType: string) => Promise<string>;
}) {
  return (
    <View>
      <TextField
        label="Image URL"
        value={block.url}
        onChangeText={(url) => onChange({ url })}
        placeholder="https://…"
        autoCapitalize="none"
        keyboardType="url"
      />
      {uploadImage ? <ImageUploadButton onUploaded={(url) => onChange({ url })} uploadImage={uploadImage} /> : null}
      <TextField
        label="Alt text"
        value={block.alt}
        onChangeText={(alt) => onChange({ alt })}
        placeholder="Describes the image for screen readers / blocked images"
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

/** Cross-platform "Upload image" affordance — web file input, native picker,
 *  mirroring `CoverPhotoPicker`'s upload flow (generate-URL, POST, resolve to
 *  a servable URL) which is the app's only prior image-upload precedent. */
function ImageUploadButton({
  uploadImage,
  onUploaded,
}: {
  uploadImage: (file: Blob, contentType: string) => Promise<string>;
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      const url = await uploadImage(blob, contentType);
      onUploaded(url);
    } finally {
      setUploading(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  return (
    <Pressable
      onPress={() => (Platform.OS === "web" ? pickWeb() : void pickNative())}
      disabled={uploading}
      className="mb-3 flex-row items-center gap-2 self-start rounded-md border border-border-strong bg-raised px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
    >
      {uploading ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      <Text className="text-xs font-semibold text-ink">
        {uploading ? "Uploading…" : "Upload image…"}
      </Text>
    </Pressable>
  );
}
