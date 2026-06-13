import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  TextField,
  EmptyState,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";
import { CORE_COMPONENTS, LIGHTWEIGHT_ROLE_KEYS } from "@events-os/shared";

/** TEMPLATES list + inline "new template" creator. */
export default function TemplatesScreen() {
  const router = useRouter();
  const templates = useQuery(api.eventTypes.list);
  const roles = useQuery(api.roles.list);
  const create = useMutation(api.eventTypes.create);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  if (templates === undefined || roles === undefined) return <Screen loading />;

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      // Map the lightweight role keys to this chapter's role ids; fall back to
      // all roles if none of the lightweight keys are present.
      const lightweight = roles!.filter((r: any) =>
        LIGHTWEIGHT_ROLE_KEYS.includes(r.key),
      );
      const activeRoleIds = (lightweight.length > 0 ? lightweight : roles!).map(
        (r: any) => r._id,
      );
      const id = await create({
        name: trimmed,
        activeRoleIds,
        activeComponents: [...CORE_COMPONENTS],
      });
      setName("");
      router.push(`/template/${id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Screen>
      <Card style={styles.creator}>
        <TextField
          label="New template"
          placeholder="e.g. Worship With Strangers"
          value={name}
          onChangeText={setName}
          onSubmitEditing={handleCreate}
          returnKeyType="done"
        />
        <Button
          title="+ Create template"
          onPress={handleCreate}
          loading={creating}
          disabled={!name.trim()}
        />
      </Card>

      {templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          message="Create your first reusable event blueprint above."
        />
      ) : (
        <View style={styles.list}>
          {templates.map((t: any) => (
            <Card
              key={t._id}
              onPress={() => router.push(`/template/${t._id}`)}
            >
              <View style={styles.cardTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {t.name}
                </Text>
                <Badge label={`v${t.version}`} tone="neutral" />
              </View>
              {t.description ? (
                <Text style={styles.desc} numberOfLines={2}>
                  {t.description}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                {t.roles.length} roles · {t.taskCount} tasks
              </Text>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  creator: { gap: spacing.sm },
  list: { marginTop: spacing.lg, gap: spacing.md },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  desc: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  meta: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
});
