/**
 * TEMPLATES VIEW — the templates list + inline creator + archived section.
 *
 * Extracted from the Templates screen so it can render both there (its own
 * route, kept for deep links) and inside the Events tab's Templates segment.
 * Templates are reusable event blueprints: create one, tap to edit its roles /
 * modules / crew, then start events from it.
 *
 * Self-contained: it owns its own queries + mutations, so both mount points
 * render `<TemplatesView />` with no wiring. Callers gate visibility (admin or
 * lead) — this component assumes the caller is allowed to manage templates.
 */
import { useRef, useState } from "react";
import { View, Text, Pressable, Platform, Alert, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Card,
  Button,
  Badge,
  TextField,
  EmptyState,
  Icon,
  ContextMenu,
  measureAnchor,
  ToastView,
  type ContextMenuAnchor,
} from "../ui";
import { colors, spacing } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";

/** A single template row from `api.templates.list`. */
type Template = FunctionReturnType<typeof api.templates.list>[number];

/** TEMPLATES list + inline "new template" creator + archived section. */
export function TemplatesView() {
  const router = useRouter();
  const templates = useQuery(api.templates.list);
  const archivedTemplates = useQuery(api.templates.listArchived);
  const create = useMutation(api.templates.create);
  const duplicate = useMutation(api.templates.duplicate);
  const archive = useMutation(api.templates.archive);
  const unarchive = useMutation(api.templates.unarchive);

  const { run, toast, dismiss } = useActionRunner();

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The card whose context menu is open (id + measured anchor rect).
  const [menu, setMenu] = useState<{
    id: Id<"eventTypes">;
    anchor: ContextMenuAnchor;
  } | null>(null);

  if (templates === undefined) {
    return (
      <View style={{ paddingVertical: spacing.lg }}>
        <Text className="text-sm text-faint">Loading templates…</Text>
      </View>
    );
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      // The backend seeds the template's roles from DEFAULT_ROLES and enables
      // every core module by default (deltas disable, not enable).
      const id = await run(() => create({ name: trimmed }), {
        errorTitle: "Couldn't create template",
      });
      if (id) {
        setName("");
        router.push(`/template/${id}`);
      }
    } finally {
      setCreating(false);
    }
  }

  const menuTemplate = templates.find((t) => t._id === menu?.id) ?? null;

  async function handleDuplicate(id: Id<"eventTypes">) {
    const newId = await run(() => duplicate({ eventTypeId: id }), {
      errorTitle: "Couldn't duplicate template",
    });
    if (newId) router.push(`/template/${newId}`);
  }

  function handleArchive(template: Template) {
    confirmArchiveTemplate(template.name, () =>
      run(() => archive({ eventTypeId: template._id }), {
        errorTitle: "Couldn't archive template",
      }),
    );
  }

  const archived = archivedTemplates ?? [];

  return (
    <>
      <ToastView toast={toast} onDismiss={dismiss} />
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
          {templates.map((t) => (
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
              {archived.map((t) => (
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
                      onPress={() =>
                        run(() => unarchive({ eventTypeId: t._id }), {
                          errorTitle: "Couldn't revive template",
                        })
                      }
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
    </>
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
  template: Template;
  onPress: () => void;
  onOpenMenu: (anchor: ContextMenuAnchor) => void;
}) {
  const ref = useRef<View>(null);

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
