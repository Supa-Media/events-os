/**
 * Page setup — cover photo, copy, venue, and visibility toggles for the
 * public event page. Text fields buffer locally and commit via the Save
 * button; toggles and the visibility pills save immediately.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { Button, Card, Icon, Pill, TextField, Field } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { ToggleRow } from "./ToggleRow";

type Props = {
  page: Doc<"eventPages">;
  coverUrl: string | null;
  run: ActionRunner["run"];
};

export function PageSetupCard({ page, coverUrl, run }: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);

  // Local edit buffers, seeded from the server row once.
  const [tagline, setTagline] = useState(page.tagline ?? "");
  const [description, setDescription] = useState(page.description ?? "");
  const [venueName, setVenueName] = useState(page.venueName ?? "");
  const [address, setAddress] = useState(page.address ?? "");
  const [capacity, setCapacity] = useState(
    page.capacity != null ? String(page.capacity) : "",
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const patchPage = (patch: Parameters<typeof updatePage>[0]["patch"]) =>
    run(() => updatePage({ pageId: page._id, patch }), {
      errorTitle: "Couldn't update page",
    });

  // ── Cover upload (mirrors the grid PhotoCell: web file input / native picker)
  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      await run(
        async () => {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          const { storageId } = await res.json();
          await updatePage({ pageId: page._id, patch: { coverImage: storageId } });
        },
        { errorTitle: "Couldn't upload cover" },
      );
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

  function pickCover() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  async function handleSave() {
    const capTrimmed = capacity.trim();
    const capParsed =
      capTrimmed === "" ? null : Math.max(0, Math.floor(Number(capTrimmed)));
    setSaving(true);
    await patchPage({
      tagline: tagline.trim(),
      description: description.trim(),
      venueName: venueName.trim(),
      address: address.trim(),
      ...(capParsed === null || !Number.isNaN(capParsed)
        ? { capacity: capParsed }
        : {}),
    });
    setSaving(false);
  }

  return (
    <Card>
      {/* Cover photo — 4:5, tap to upload/change */}
      <Pressable
        onPress={pickCover}
        disabled={uploading}
        accessibilityLabel="Change cover photo"
        className="mb-1 w-full max-w-[280px] items-center justify-center self-center overflow-hidden rounded-xl border border-border bg-sunken active:opacity-80"
        style={{ aspectRatio: 4 / 5 }}
      >
        {uploading ? (
          <ActivityIndicator color={colors.accent} />
        ) : coverUrl ? (
          <Image
            source={{ uri: coverUrl }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="cover"
          />
        ) : (
          <View className="items-center gap-2 px-6">
            <Icon name="image" size={22} color={colors.faint} />
            <Text className="text-center text-sm text-muted">
              Tap to add a cover photo
            </Text>
          </View>
        )}
      </Pressable>
      {coverUrl ? (
        <Pressable
          onPress={() => void patchPage({ coverImage: null })}
          className="mb-3 self-center active:opacity-70"
        >
          <Text className="text-xs font-semibold text-muted">Remove cover</Text>
        </Pressable>
      ) : (
        <View className="mb-3" />
      )}

      <TextField
        label="Tagline"
        value={tagline}
        onChangeText={setTagline}
        placeholder="One line that sells the night"
      />
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="What should guests expect?"
        multiline
        numberOfLines={4}
        style={{ minHeight: 96, textAlignVertical: "top" }}
      />
      <TextField
        label="Venue name"
        value={venueName}
        onChangeText={setVenueName}
        placeholder="The Chapel"
      />
      <TextField
        label="Address"
        value={address}
        onChangeText={setAddress}
        placeholder="123 Main St, Austin TX"
      />

      <Field label="Address visibility">
        <View className="flex-row gap-2">
          <Pill
            label="Public"
            selected={page.addressVisibility === "public"}
            onPress={() => void patchPage({ addressVisibility: "public" })}
          />
          <Pill
            label="After RSVP"
            selected={page.addressVisibility === "after_rsvp"}
            onPress={() => void patchPage({ addressVisibility: "after_rsvp" })}
          />
        </View>
      </Field>

      <TextField
        label="Capacity"
        value={capacity}
        onChangeText={setCapacity}
        placeholder="Unlimited"
        keyboardType="numeric"
        hint="Optional — 'going' RSVPs stop at this number."
      />

      <ToggleRow
        label="RSVPs enabled"
        hint="Guests can RSVP going / maybe / can't go."
        value={page.rsvpEnabled !== false}
        onToggle={(next) => void patchPage({ rsvpEnabled: next })}
      />
      <ToggleRow
        label="Guest list visible"
        hint="Show who's coming on the public page."
        value={page.showGuestList !== false}
        onToggle={(next) => void patchPage({ showGuestList: next })}
      />
      <ToggleRow
        label="Activity locked until RSVP"
        hint="Comments and the feed unlock after guests RSVP."
        value={page.activityRestricted !== false}
        onToggle={(next) => void patchPage({ activityRestricted: next })}
      />

      <View className="mt-3 flex-row justify-end">
        <Button
          title="Save"
          icon="check"
          loading={saving}
          onPress={() => void handleSave()}
        />
      </View>
    </Card>
  );
}
