/**
 * "Save as template" — turns the campaign currently open in the composer into
 * a reusable starting point (`campaignTemplates.createTemplateFromCampaign`).
 *
 * ── Why it lives in the composer header ────────────────────────────────────
 * A template is worth saving at the moment the email finally looks right,
 * which is when you're standing in the designer — not later, from a list
 * screen, having to remember which of five drafts was the good one.
 *
 * ── Why an inline prompt rather than a dialog ──────────────────────────────
 * The app has no modal primitive (`Popover`/`ContextMenu` are anchored menus,
 * not content panels) and `Alert.prompt` is iOS-only, so a name has to be
 * collected in the page. This uses the same expand-in-place idiom as
 * `CampaignsListView`'s inline creator and `ui/Field.tsx`'s `Select`: press
 * once to reveal a name field, press again to commit. The campaign's own name
 * is pre-filled, since "Monthly newsletter" is nearly always the right answer.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card, TextField } from "../ui";
import type { ActionRunner } from "../../lib/useActionToast";

export function SaveAsTemplateAction({
  campaignId,
  campaignName,
  run,
}: {
  campaignId: Id<"campaigns">;
  campaignName: string;
  run: ActionRunner["run"];
}) {
  const createTemplate = useMutation(api.campaignTemplates.createTemplateFromCampaign);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(campaignName);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const id = await run(() => createTemplate({ campaignId, name: trimmed }), {
        errorTitle: "Couldn't save this as a template",
      });
      // `run` resolves to undefined when it swallowed a failure — only treat
      // it as saved when a real id came back.
      if (id !== undefined) {
        setSavedAs(trimmed);
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <View className="items-end">
        <Button
          title="Save as template"
          variant="secondary"
          size="sm"
          icon="bookmark"
          onPress={() => {
            setName(campaignName);
            setSavedAs(null);
            setOpen(true);
          }}
        />
        {savedAs ? (
          <Text className="mt-1 text-2xs text-success">
            Saved “{savedAs}” — it&apos;s in the template list now.
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <Card padding="sm" className="w-[320px]">
      <TextField
        label="Template name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Monthly newsletter"
        hint="Saves this email's blocks and theme — not its audience or subject."
        autoFocus
      />
      <View className="flex-row justify-end gap-2">
        <Button
          title="Cancel"
          variant="ghost"
          size="sm"
          onPress={() => setOpen(false)}
        />
        <Button
          title="Save template"
          size="sm"
          loading={saving}
          disabled={name.trim() === ""}
          onPress={() => void save()}
        />
      </View>
    </Card>
  );
}
