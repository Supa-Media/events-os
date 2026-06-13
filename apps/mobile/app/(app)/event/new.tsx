import { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
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
} from "../../../components/ui";
import { colors, radius, spacing } from "../../../lib/theme";
import { parseDateInput } from "../../../lib/format";

/** NEW EVENT: pick a template, name it, set a date, create. */
export default function NewEventScreen() {
  const router = useRouter();
  const { templateId } = useLocalSearchParams<{ templateId?: string }>();
  const templates = useQuery(api.eventTypes.list);
  const create = useMutation(api.events.createFromTemplate);

  const [selectedId, setSelectedId] = useState<string | null>(
    templateId ?? null,
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

  const selected = templates.find((t: any) => t._id === selectedId) ?? null;
  // Default the name to the template name until the user types their own.
  const effectiveName = touchedName ? name : selected?.name ?? "";

  function pickTemplate(t: any) {
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
      setError("Enter a valid date as YYYY-MM-DD.");
      return;
    }
    setCreating(true);
    try {
      const id = await create({
        eventTypeId: selectedId as any,
        name: finalName,
        eventDate: ts,
        location: location.trim() || undefined,
      });
      router.replace(`/event/${id}`);
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
            {templates.map((t: any) => {
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
          <TextField
            label="Date"
            placeholder="YYYY-MM-DD"
            value={date}
            onChangeText={setDate}
            hint="The whole task timeline is back-calculated from this date."
            autoCapitalize="none"
          />
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
});
