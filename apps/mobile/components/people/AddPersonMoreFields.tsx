/**
 * The Add Person modal's "More details" disclosure — every roster column
 * beyond the always-visible Name/Contact fields, grouped exactly the way
 * `PersonDetailBody` (`app/(app)/(tabs)/people.tsx`) already labels its own
 * sections (Details, Marketing) so the add flow and the edit sheet read as
 * the same product. One small function per group.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon, PersonPicker, Select, ServiceOptionsPicker, Switch, TextField } from "../ui";
import { colors } from "../../lib/theme";
import { buildServiceLabelMap } from "../../lib/serviceCatalog";
import type { AddPersonFormState } from "./addPersonForm.logic";

const STATUS_SELECT_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "transitioning_in", label: "Transitioning in" },
  { value: "transitioning_out", label: "Transitioning out" },
  { value: "unavailable", label: "Unavailable" },
];

const VETTING_SELECT_OPTIONS = [
  { value: "unvetted", label: "Unvetted" },
  { value: "pending", label: "Pending" },
  { value: "vetted", label: "Vetted" },
];

const GENDER_SELECT_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "na", label: "N/A" },
];

type OnChange = <K extends keyof AddPersonFormState>(
  key: K,
  value: AddPersonFormState[K],
) => void;

function SectionLabel({ label }: { label: string }) {
  return (
    <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
      {label}
    </Text>
  );
}

function RoleFields({ form, onChange }: { form: AddPersonFormState; onChange: OnChange }) {
  return (
    <View className="mb-4">
      <SectionLabel label="Role" />
      <TextField
        label="Title / Role"
        value={form.role}
        onChangeText={(t) => onChange("role", t)}
        placeholder="e.g. Worship Leader"
      />
      <TextField
        label="Company"
        value={form.company}
        onChangeText={(t) => onChange("company", t)}
        placeholder="Vendor org, if any"
      />
      <TextField
        label="PW Email"
        value={form.pwEmail}
        onChangeText={(t) => onChange("pwEmail", t)}
        placeholder="name@publicworship.life"
        autoCapitalize="none"
        keyboardType="email-address"
      />
    </View>
  );
}

function StatusFields({ form, onChange }: { form: AddPersonFormState; onChange: OnChange }) {
  return (
    <View className="mb-4">
      <SectionLabel label="Status & vetting" />
      <Select
        label="Status"
        value={form.status}
        options={STATUS_SELECT_OPTIONS}
        onChange={(v) => onChange("status", v as AddPersonFormState["status"])}
      />
      <Select
        label="Vetting"
        value={form.vettingStatus}
        options={VETTING_SELECT_OPTIONS}
        onChange={(v) => onChange("vettingStatus", v as AddPersonFormState["vettingStatus"])}
      />
      <Select
        label="Gender"
        value={form.gender}
        options={GENDER_SELECT_OPTIONS}
        onChange={(v) => onChange("gender", v as AddPersonFormState["gender"])}
      />
      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-sm text-ink">Core team member</Text>
        <Switch
          value={form.isTeamMember}
          onValueChange={(v) => onChange("isTeamMember", v)}
          accessibilityLabel="Core team member"
        />
      </View>
    </View>
  );
}

function ServicesAndRateFields({
  form,
  onChange,
}: {
  form: AddPersonFormState;
  onChange: OnChange;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const tree = useQuery(api.serviceOptions.list, { includeInactive: true });
  const labelById = useMemo(
    () => (tree ? buildServiceLabelMap(tree) : new Map<Id<"serviceOptions">, string>()),
    [tree],
  );

  return (
    <View className="mb-4">
      <SectionLabel label="Services & rate" />
      <Pressable
        onPress={() => setPickerOpen(true)}
        className="mb-3 flex-row flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-raised px-3 py-2.5"
      >
        {form.serviceIds.length === 0 ? (
          <Text className="text-base text-faint">—</Text>
        ) : (
          form.serviceIds.map((sid) => (
            <View key={sid} className="rounded-pill bg-sunken px-2 py-0.5">
              <Text className="text-xs text-ink">{labelById.get(sid) ?? "…"}</Text>
            </View>
          ))
        )}
      </Pressable>
      <TextField
        label="Usual rate USD"
        value={form.usualRateUsd}
        onChangeText={(t) => onChange("usualRateUsd", t)}
        placeholder="0"
        keyboardType="numeric"
      />
      <ServiceOptionsPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mode="multi"
        selectedIds={form.serviceIds}
        onChange={(ids) => onChange("serviceIds", ids)}
        title="Services"
      />
    </View>
  );
}

function ManagerField({
  managerId,
  onChange,
}: {
  managerId: Id<"people"> | null;
  onChange: (id: Id<"people"> | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Same lightweight `{_id, name}` projection the grid's own manager column
  // resolves names from — this modal has no roster row of its own to read a
  // name off of.
  const allNames = useQuery(api.people.namesByChapter, {});
  const managerName = managerId
    ? (allNames ?? []).find((p) => p._id === managerId)?.name ?? null
    : null;

  return (
    <View className="mb-4">
      <SectionLabel label="Manager" />
      <Pressable
        onPress={() => setPickerOpen(true)}
        className="flex-row items-center justify-between rounded-md border border-border-strong bg-raised px-3 py-2.5"
      >
        <Text className={`text-base ${managerName ? "text-ink" : "text-faint"}`}>
          {managerName ?? "—"}
        </Text>
        <Icon name="chevron-down" size={16} color={colors.muted} />
      </Pressable>
      <PersonPicker
        visible={pickerOpen}
        title="Set manager"
        selectedId={managerId}
        source="team"
        onPick={(id) => {
          onChange(id as Id<"people">);
          setPickerOpen(false);
        }}
        onClear={() => {
          onChange(null);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

function DetailsFields({ form, onChange }: { form: AddPersonFormState; onChange: OnChange }) {
  return (
    <View className="mb-4">
      <SectionLabel label="Details" />
      <TextField
        label="Location"
        value={form.location}
        onChangeText={(t) => onChange("location", t)}
        placeholder="City, State"
      />
      <TextField
        label="How they heard about us"
        value={form.referralSource}
        onChangeText={(t) => onChange("referralSource", t)}
        placeholder="Instagram, a friend, …"
      />
      <TextField
        label="POC name"
        value={form.pocName}
        onChangeText={(t) => onChange("pocName", t)}
        placeholder="Point of contact"
      />
      <TextField
        label="Involvements"
        value={form.projects}
        onChangeText={(t) => onChange("projects", t)}
        placeholder="Eden, Love Thy Neighbor…"
      />
      <TextField
        label="Comms preferences"
        value={form.commsPreferences}
        onChangeText={(t) => onChange("commsPreferences", t)}
        placeholder="slack, call, text…"
      />
      <TextField
        label="Social link"
        value={form.socialLink}
        onChangeText={(t) => onChange("socialLink", t)}
        placeholder="https://…"
        autoCapitalize="none"
      />
      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-sm text-ink">Marked as volunteer</Text>
        <Switch
          value={form.isVolunteer}
          onValueChange={(v) => onChange("isVolunteer", v)}
          accessibilityLabel="Marked as volunteer"
        />
      </View>
    </View>
  );
}

function MarketingField({ form, onChange }: { form: AddPersonFormState; onChange: OnChange }) {
  return (
    <View className="mb-4">
      <SectionLabel label="Marketing" />
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-ink">Marketing emails</Text>
        <Switch
          // Inverted, same as `PersonDetailBody`'s own marketing toggle: the
          // form holds `marketingOptOut`, the switch reads/writes "On".
          value={!form.marketingOptOut}
          onValueChange={(on) => onChange("marketingOptOut", !on)}
          accessibilityLabel="Marketing emails"
        />
      </View>
    </View>
  );
}

function NotesField({ form, onChange }: { form: AddPersonFormState; onChange: OnChange }) {
  return (
    <View className="mb-1">
      <SectionLabel label="Notes" />
      <TextField
        value={form.notes}
        onChangeText={(t) => onChange("notes", t)}
        placeholder="Preferences, availability, context…"
        multiline
        numberOfLines={3}
      />
    </View>
  );
}

export function AddPersonMoreFields({
  form,
  onChange,
  canSetManager,
}: {
  form: AddPersonFormState;
  onChange: OnChange;
  canSetManager: boolean;
}) {
  return (
    <View>
      <RoleFields form={form} onChange={onChange} />
      <StatusFields form={form} onChange={onChange} />
      <ServicesAndRateFields form={form} onChange={onChange} />
      {canSetManager ? (
        <ManagerField
          managerId={form.managerId}
          onChange={(id) => onChange("managerId", id)}
        />
      ) : null}
      <DetailsFields form={form} onChange={onChange} />
      <MarketingField form={form} onChange={onChange} />
      <NotesField form={form} onChange={onChange} />
    </View>
  );
}
