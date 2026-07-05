/**
 * Page setup — cover photo, copy, venue, and visibility toggles for the
 * public event page. Text fields buffer locally and commit via the Save
 * button; toggles and the visibility pills save immediately.
 */
import { useState } from "react";
import { View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc } from "@events-os/convex/_generated/dataModel";
import { Button, Card, Pill, TextField, Field } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { CoverPhotoPicker } from "./CoverPhotoPicker";
import { ToggleRow } from "./ToggleRow";

type Props = {
  page: Doc<"eventPages">;
  coverUrl: string | null;
  run: ActionRunner["run"];
};

export function PageSetupCard({ page, coverUrl, run }: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);

  // Local edit buffers, seeded from the server row once.
  const [tagline, setTagline] = useState(page.tagline ?? "");
  const [description, setDescription] = useState(page.description ?? "");
  const [venueName, setVenueName] = useState(page.venueName ?? "");
  const [address, setAddress] = useState(page.address ?? "");
  const [capacity, setCapacity] = useState(
    page.capacity != null ? String(page.capacity) : "",
  );
  const [saving, setSaving] = useState(false);

  const patchPage = (patch: Parameters<typeof updatePage>[0]["patch"]) =>
    run(() => updatePage({ pageId: page._id, patch }), {
      errorTitle: "Couldn't update page",
    });

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
      <CoverPhotoPicker page={page} coverUrl={coverUrl} run={run} />

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
