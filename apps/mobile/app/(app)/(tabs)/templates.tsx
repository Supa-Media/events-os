import { useRef, useState } from "react";
import { View, Text, Pressable, Platform, Alert, StyleSheet } from "react-native";
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
  Icon,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
} from "../../../components/ui";
import { colors, spacing } from "../../../lib/theme";

/** TEMPLATES list + inline "new template" creator + archived section. */
export default function TemplatesScreen() {
  const router = useRouter();
  const templates = useQuery(api.eventTypes.list);
  const archivedTemplates = useQuery(api.eventTypes.listArchived);
  const create = useMutation(api.eventTypes.create);
  const duplicate = useMutation(api.eventTypes.duplicate);
  const archive = useMutation(api.eventTypes.archive);
  const unarchive = useMutation(api.eventTypes.unarchive);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The card whose context menu is open (id + measured anchor rect).
  const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(
    null,
  );

  if (templates === undefined) return <Screen loading />;

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      // The backend seeds the template's roles from DEFAULT_ROLES and enables
      // every core module by default (deltas disable, not enable).
      const id = await create({ name: trimmed });
      setName("");
      router.push(`/template/${id}`);
    } finally {
      setCreating(false);
    }
  }

  const menuTemplate = templates.find((t: any) => t._id === menu?.id) ?? null;

  async function handleDuplicate(id: string) {
    const newId = await duplicate({ eventTypeId: id as any });
    router.push(`/template/${newId}`);
  }

  function handleArchive(template: { _id: string; name: string }) {
    confirmArchiveTemplate(template.name, () =>
      archive({ eventTypeId: template._id as any }),
    );
  }

  const archived = archivedTemplates ?? [];

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
            <TemplateCard
              key={t._id}
              template={t}
              onPress={() => router.push(`/template/${t._id}`)}
              onOpenMenu={(anchor) => setMenu({ id: t._id, anchor })}
            />
          ))}
        </View>
      )}

      {archived.length > 0 ? (
        <View style={styles.archivedSection}>
          <Pressable
            onPress={() => setShowArchived((v) => !v)}
            className="flex-row items-center gap-2 py-2 active:opacity-80"
          >
            <Icon
              name={showArchived ? "chevron-down" : "chevron-right"}
              size={16}
              color={colors.muted}
            />
            <Text style={styles.archivedHeader}>
              Archived templates ({archived.length})
            </Text>
          </Pressable>
          {showArchived ? (
            <View style={styles.list}>
              {archived.map((t: any) => (
                <Card key={t._id} padding="md">
                  <View style={styles.archivedRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name} numberOfLines={1}>
                        {t.name}
                      </Text>
                      <Text style={styles.meta}>
                        {t.roles.length} roles · {t.taskCount} tasks
                      </Text>
                    </View>
                    <Button
                      title="Revive"
                      variant="secondary"
                      onPress={() => unarchive({ eventTypeId: t._id as any })}
                    />
                  </View>
                </Card>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Right-click / long-press menu for the active card. */}
      <ContextMenu
        anchor={menu?.anchor}
        onClose={() => setMenu(null)}
        actions={[
          {
            label: "Duplicate",
            icon: "copy",
            onPress: () => {
              if (menuTemplate) handleDuplicate(menuTemplate._id);
            },
          },
          {
            label: "Archive",
            icon: "archive",
            destructive: true,
            onPress: () => {
              if (menuTemplate) handleArchive(menuTemplate);
            },
          },
        ]}
      />
    </Screen>
  );
}

/** Warn before archiving (web `window.confirm`, native `Alert.alert`). */
function confirmArchiveTemplate(name: string, onConfirm: () => void) {
  const message =
    `Archive ‘${name}’? It'll be hidden from your templates and you ` +
    `won't be able to start new events from it. Events already created from ` +
    `it are unaffected — you can revive it anytime from Archived templates.`;
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(message)) onConfirm();
    return;
  }
  Alert.alert("Archive template?", message, [
    { text: "Cancel", style: "cancel" },
    { text: "Archive", style: "destructive", onPress: onConfirm },
  ]);
}

/**
 * One template card. Tap navigates to the editor; right-click (web) /
 * long-press (native) opens the Duplicate / Archive context menu.
 */
function TemplateCard({
  template,
  onPress,
  onOpenMenu,
}: {
  template: any;
  onPress: () => void;
  onOpenMenu: (anchor: ContextMenuAnchor) => void;
}) {
  const ref = useRef<any>(null);

  function open() {
    measureAnchor(ref.current, onOpenMenu);
  }

  // Web right-click opens the menu; native long-press is the fallback.
  const webProps =
    Platform.OS === "web"
      ? ({
          onContextMenu: (e: any) => {
            e?.preventDefault?.();
            open();
          },
        } as any)
      : {};

  return (
    <View ref={ref} {...webProps}>
      <Pressable onLongPress={open} delayLongPress={300}>
        <Card onPress={onPress}>
          <View style={styles.cardTop}>
            <Text style={styles.name} numberOfLines={1}>
              {template.name}
            </Text>
            <Badge label={`v${template.version}`} tone="neutral" />
          </View>
          {template.description ? (
            <Text style={styles.desc} numberOfLines={2}>
              {template.description}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {template.roles.length} roles · {template.taskCount} tasks
          </Text>
        </Card>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  creator: { gap: spacing.sm },
  list: { marginTop: spacing.md, gap: spacing.md },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  desc: { fontSize: 13, color: colors.muted, marginTop: spacing.xs },
  meta: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
  archivedSection: { marginTop: spacing.xl },
  archivedHeader: { fontSize: 14, fontWeight: "600", color: colors.muted },
  archivedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
});
