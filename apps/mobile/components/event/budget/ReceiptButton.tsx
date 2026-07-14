/**
 * Per-line receipt attachment — a small tap target that uploads a receipt image
 * (web file input / native picker) into Convex storage and stores its
 * `storageId` on the budget line via `budget.setReceipt`. Mirrors the
 * CoverPhotoPicker / grid PhotoCell generate-url → POST → store-storageId flow.
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
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction } from "../ticketing/helpers";

type Props = {
  lineItemId: Id<"budgetLineItems">;
  receiptUrl: string | null;
  run: ActionRunner["run"];
};

export function ReceiptButton({ lineItemId, receiptUrl, run }: Props) {
  const setReceipt = useMutation(api.budget.setReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const [uploading, setUploading] = useState(false);

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
          await setReceipt({ lineItemId, receiptStorageId: storageId });
        },
        { errorTitle: "Couldn't attach receipt" },
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

  function pick() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  function clear() {
    confirmAction({
      title: "Remove receipt?",
      message: "The attached receipt will be detached from this line.",
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => setReceipt({ lineItemId, receiptStorageId: null }), {
          errorTitle: "Couldn't remove receipt",
        }),
      destructive: true,
    });
  }

  if (uploading) {
    return (
      <View
        className="h-11 w-11 items-center justify-center rounded-md border border-border bg-sunken"
        accessibilityLabel="Uploading receipt"
      >
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }

  if (receiptUrl) {
    return (
      <Pressable
        onPress={clear}
        accessibilityLabel="Remove receipt"
        className="h-11 w-11 overflow-hidden rounded-md border border-border bg-sunken active:opacity-80"
      >
        <Image
          source={{ uri: receiptUrl }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="cover"
        />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={pick}
      accessibilityLabel="Attach receipt"
      className="h-11 w-11 items-center justify-center rounded-md border border-dashed border-border-strong bg-raised active:opacity-70"
    >
      <Icon name="paperclip" size={16} color={colors.muted} />
      <Text className="mt-0.5 text-2xs text-faint">Receipt</Text>
    </Pressable>
  );
}
