import { createElement, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  TextInput,
} from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  TextField,
  EmptyState,
  SectionHeader,
  Field,
} from "../../../components/ui";
import { colors, radius, spacing } from "../../../lib/theme";
import { parseDateInput, formatDate } from "../../../lib/format";
import { errorMessage } from "../../../lib/errors";
import type { Id } from "@events-os/convex/_generated/dataModel";

/**
 * Date picker. On web this is the browser's native `<input type="date">` (real
 * calendar). On native — where the app ships no date-picker dependency — three
 * numeric fields (year / month / day) avoid the free-text typo trap of a single
 * `YYYY-MM-DD` box while staying dependency-free. Both paths emit a canonical
 * `YYYY-MM-DD` string so the timeline back-calculation downstream is unchanged.
 */
function DatePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  if (Platform.OS === "web") {
    return (
      <Field
        label="Date"
        hint="The whole task timeline is back-calculated from this date."
      >
        {createElement("input", {
          type: "date",
          value,
          "aria-label": "Event date",
          onChange: (e: any) => onChange(e.target.value),
          style: {
            font: "inherit",
            fontSize: 15,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: "10px 12px",
            background: colors.surface,
            outline: "none",
          },
        })}
      </Field>
    );
  }

  // Native: split the YYYY-MM-DD string into three editable numeric fields.
  const [y = "", m = "", d = ""] = value ? value.split("-") : [];
  const part = (pos: "y" | "m" | "d", next: string) => {
    const digits = next.replace(/[^0-9]/g, "");
    const ny = pos === "y" ? digits : y;
    const nm = pos === "m" ? digits : m;
    const nd = pos === "d" ? digits : d;
    onChange(`${ny}-${nm}-${nd}`);
  };
  return (
    <Field
      label="Date"
      hint="The whole task timeline is back-calculated from this date."
    >
      <View style={styles.dateParts}>
        <TextInput
          style={[styles.datePart, styles.datePartWide]}
          placeholder="YYYY"
          placeholderTextColor={colors.faint}
          value={y}
          onChangeText={(t) => part("y", t)}
          keyboardType="number-pad"
          maxLength={4}
          accessibilityLabel="Event year"
        />
        <Text style={styles.dateSep}>-</Text>
        <TextInput
          style={styles.datePart}
          placeholder="MM"
          placeholderTextColor={colors.faint}
          value={m}
          onChangeText={(t) => part("m", t)}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Event month"
        />
        <Text style={styles.dateSep}>-</Text>
        <TextInput
          style={styles.datePart}
          placeholder="DD"
          placeholderTextColor={colors.faint}
          value={d}
          onChangeText={(t) => part("d", t)}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Event day"
        />
      </View>
    </Field>
  );
}

/** NEW EVENT: pick a template, name it, set a date, create. */
export default function NewEventScreen() {
  const router = useRouter();
  const { templateId } = useLocalSearchParams<{ templateId?: string }>();
  const templates = useQuery(api.eventTypes.list);
  type TemplateRow = NonNullable<typeof templates>[number];
  const create = useMutation(api.events.createFromTemplate);

  const [selectedId, setSelectedId] = useState<Id<"eventTypes"> | null>(
    (templateId as Id<"eventTypes"> | undefined) ?? null,
  );
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (templates === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "New event" }} />
        <Screen loading />
      </>
    );
  }

  const selected = templates.find((t) => t._id === selectedId) ?? null;
  // Default the name to the template name until the user types their own.
  const effectiveName = touchedName ? name : selected?.name ?? "";
  const parsedDate = date ? parseDateInput(date) : null;

  function pickTemplate(t: TemplateRow) {
    setSelectedId(t._id);
    if (!touchedName) setName("");
  }

  async function handleCreate() {
    setError(null);
    if (!selectedId) {
      setError("Pick a template first.");
      return;
    }
    const finalName = effectiveName.trim();
    if (!finalName) {
      setError("Give the event a name.");
      return;
    }
    const ts = parseDateInput(date);
    if (ts === null) {
      setError(
        date.trim()
          ? "That date isn't valid — check the year, month, and day."
          : "Pick an event date.",
      );
      return;
    }
    setCreating(true);
    try {
      const id = await create({
        eventTypeId: selectedId,
        name: finalName,
        eventDate: ts,
        location: location.trim() || undefined,
      });
      router.replace(`/event/${id}`);
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the event."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "New event" }} />
      <Screen>
        <SectionHeader title="Template" />
        {templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            message="Create a template before starting an event."
            action={
              <Button
                title="Go to Templates"
                variant="secondary"
                onPress={() => router.replace("/templates")}
              />
            }
          />
        ) : (
          <View style={styles.templateList}>
            {templates.map((t: TemplateRow) => {
              const active = t._id === selectedId;
              return (
                <Pressable
                  key={t._id}
                  onPress={() => pickTemplate(t)}
                  style={[styles.templateRow, active && styles.templateActive]}
                >
                  <View style={styles.templateText}>
                    <Text style={styles.templateName}>{t.name}</Text>
                    <Text style={styles.templateMeta}>
                      {t.roles.length} roles · {t.taskCount} tasks
                    </Text>
                  </View>
                  {active ? <Badge label="Selected" tone="accent" /> : null}
                </Pressable>
              );
            })}
          </View>
        )}

        <SectionHeader title="Details" />
        <Card>
          <TextField
            label="Event name"
            placeholder={selected?.name ?? "Name"}
            value={effectiveName}
            onChangeText={(v) => {
              setTouchedName(true);
              setName(v);
            }}
          />
          <DatePickerField value={date} onChange={setDate} />
          {parsedDate !== null ? (
            <Text style={styles.dateConfirm}>{formatDate(parsedDate)}</Text>
          ) : null}
          <TextField
            label="Location (optional)"
            placeholder="Where is it?"
            value={location}
            onChangeText={setLocation}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            title="Create event"
            onPress={handleCreate}
            loading={creating}
            disabled={!selectedId}
          />
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  templateList: { gap: spacing.sm },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  templateActive: { borderColor: colors.accent, backgroundColor: colors.accentBg },
  templateText: { flex: 1, gap: 2 },
  templateName: { fontSize: 15, fontWeight: "600", color: colors.text },
  templateMeta: { fontSize: 13, color: colors.muted },
  error: { color: colors.danger, fontSize: 13, marginBottom: spacing.sm },
  dateParts: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  datePart: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    minWidth: 56,
  },
  datePartWide: { minWidth: 84 },
  dateSep: { fontSize: 16, color: colors.faint, fontWeight: "700" },
  dateConfirm: {
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
    fontSize: 13,
    color: colors.muted,
  },
});
