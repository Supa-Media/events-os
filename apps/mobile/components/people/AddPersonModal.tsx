/**
 * AddPersonModal — gathers a new roster row's fields BEFORE creating it,
 * replacing the old instant-stub-create ("New person" appears on the roster
 * the moment you click "Add", empty, before you've typed anything). First
 * name is the only required field; First/Last/Email/Phone stay always
 * visible (the four fields almost every add needs), everything else lives
 * behind a single "More details" disclosure (`AddPersonMoreFields`),
 * collapsed by default — never a wall of inputs.
 *
 * Chrome mirrors `AddResponsibilityModal`'s shell; submit orchestration is
 * `buildAddPersonArgs` (form → mutation args, `addPersonForm.logic.ts`) then
 * `addPersonAndGetOpenId` (mutation call → id-or-error, `addPerson.logic.ts`).
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, TextField } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { addPersonAndGetOpenId } from "./addPerson.logic";
import { buildAddPersonArgs, EMPTY_ADD_PERSON_FORM, type AddPersonFormState } from "./addPersonForm.logic";
import { AddPersonMoreFields } from "./AddPersonMoreFields";

export function AddPersonModal({
  onClose,
  onCreated,
  canSetManager,
}: {
  onClose: () => void;
  onCreated: (personId: string) => void;
  /** Manager assignment is admin-only, mirroring the grid's `canEditManager`
   *  gate — hidden entirely for a non-admin, not merely disabled. */
  canSetManager: boolean;
}) {
  const create = useMutation(api.people.create);
  const [form, setForm] = useState<AddPersonFormState>(EMPTY_ADD_PERSON_FORM);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof AddPersonFormState>(key: K, value: AddPersonFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    const built = buildAddPersonArgs(form);
    // Narrow on the defined arm (`args`), not `error` — same reasoning as
    // the old `handleAddRow`'s narrowing note: `error` isn't a discriminable
    // literal across this union, so checking it doesn't narrow `args` back
    // to `CreatePersonArgs`. Checking `args` does.
    if (built.args === undefined) {
      alertError(new Error(built.error));
      return;
    }
    setSubmitting(true);
    try {
      const result = await addPersonAndGetOpenId(create, built.args);
      if (result.id !== undefined) {
        onCreated(result.id);
        return;
      }
      alertError(result.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              Add person
            </Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ padding: 20 }}>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <TextField
                  label="First name"
                  value={form.firstName}
                  onChangeText={(t) => set("firstName", t)}
                  placeholder="First"
                  autoFocus
                />
              </View>
              <View className="flex-1">
                <TextField
                  label="Last name"
                  value={form.lastName}
                  onChangeText={(t) => set("lastName", t)}
                  placeholder="Last"
                />
              </View>
            </View>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <TextField
                  label="Email"
                  value={form.email}
                  onChangeText={(t) => set("email", t)}
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
              </View>
              <View className="flex-1">
                <TextField
                  label="Phone"
                  value={form.phone}
                  onChangeText={(t) => set("phone", t)}
                  placeholder="(555) 555-5555"
                  keyboardType="phone-pad"
                />
              </View>
            </View>

            <Pressable
              onPress={() => setDetailsOpen((o) => !o)}
              className="mb-3 flex-row items-center gap-1.5 py-1"
            >
              <Icon
                name={detailsOpen ? "chevron-up" : "chevron-down"}
                size={14}
                color={colors.accent}
              />
              <Text className="text-sm font-semibold text-accent">
                {detailsOpen ? "Hide details" : "More details"}
              </Text>
            </Pressable>

            {detailsOpen ? (
              <AddPersonMoreFields form={form} onChange={set} canSetManager={canSetManager} />
            ) : null}
          </ScrollView>

          <View className="flex-row items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button
              title="Add person"
              onPress={() => void submit()}
              loading={submitting}
              disabled={!form.firstName.trim() || submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
