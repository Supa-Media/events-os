/**
 * HowToDocCell — the Responsibilities grid's How-To editor, backed by the
 * SAME `docs` primitive as event-grid How-To cells: a duty's runbook can be
 * an external link, a video, a short inline note, or a full markdown page
 * with its own route and share URL. No copy-on-write here — responsibility
 * docs are shared masters, edited in place.
 *
 * `editable={false}` (an org-wide duty AUTHORED BY ANOTHER CHAPTER — see
 * `DutiesGrid`) fully disables writes, not just the kind menu: the note/
 * link/video inline text fields render as plain `<Text>` instead of
 * `InlineText`, since the backing `docs.update` mutation rejects a doc
 * outside the caller's own chapter (`requireWritableDoc`) — an editable-
 * looking field that throws on blur is worse than no field. Viewing a
 * markdown doc (navigating to `/doc/[id]`) stays available either way —
 * that's a read, not a write.
 */
import { View, Text, Pressable, Linking } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon, InlineText, Popover, useAnchor } from "../ui";
import { HOW_TO_KINDS } from "../grid/cells";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";

export type HowToDocSummary = {
  _id: Id<"docs">;
  kind: "link" | "video" | "note" | "markdown";
  title: string;
  url: string | null;
  body: string | null;
};

export function HowToDocCell({
  doc,
  editable = true,
  onSetDoc,
}: {
  doc: HowToDocSummary | null;
  editable?: boolean;
  onSetDoc: (docId: Id<"docs"> | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { ref, anchor, visible, open, close } = useAnchor();
  const createDoc = useMutation(api.docs.create);
  const updateDoc = useMutation(api.docs.update);

  async function pickKind(kind: (typeof HOW_TO_KINDS)[number]["value"]) {
    close();
    try {
      const res = await createDoc({
        kind,
        title: "Untitled",
        scope: "template",
      });
      onSetDoc(res._id as Id<"docs">);
      if (kind === "markdown") {
        router.push(
          `/doc/${res._id}?from=${encodeURIComponent(pathname)}` as any,
        );
      }
    } catch (err) {
      alertError(err);
    }
  }

  const kindMenu = (
    <>
      <Pressable
        ref={ref}
        onPress={editable ? open : undefined}
        hitSlop={6}
        accessibilityLabel="How-To kind"
        className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
      >
        <Icon name="chevron-down" size={13} color={colors.faint} />
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor} width={220}>
        <View className="py-1">
          {HOW_TO_KINDS.map((k) => (
            <Pressable
              key={k.value}
              onPress={() =>
                doc && doc.kind !== k.value
                  ? (close(),
                    void updateDoc({ docId: doc._id, kind: k.value }).catch(
                      alertError,
                    ))
                  : doc
                    ? close()
                    : void pickKind(k.value)
              }
              className="flex-row items-center justify-between gap-2 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <View className="flex-row items-center gap-2">
                <Icon name={k.icon} size={15} color={colors.muted} />
                <Text className="text-sm text-ink">{k.label}</Text>
              </View>
              {doc?.kind === k.value ? (
                <Icon name="check" size={15} color={colors.accent} />
              ) : null}
            </Pressable>
          ))}
          {doc ? (
            <Pressable
              onPress={() => {
                close();
                onSetDoc(null);
              }}
              className="flex-row items-center gap-2 border-t border-border px-3 py-2 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="x" size={15} color={colors.danger} />
              <Text className="text-sm text-danger">Remove How-To</Text>
            </Pressable>
          ) : null}
        </View>
      </Popover>
    </>
  );

  // No doc yet → the plain "+ How-To" affordance (read-only: just "—").
  if (!doc) {
    if (!editable) {
      return (
        <View className="flex-1 flex-row items-center px-1">
          <Text className="px-1 py-1.5 text-sm text-faint">—</Text>
        </View>
      );
    }
    return (
      <View className="flex-1 flex-row items-center px-1">
        <Pressable
          onPress={open}
          className="flex-1 flex-row items-center gap-1 px-1 py-1.5 active:opacity-70"
        >
          <Icon name="plus" size={13} color={colors.faint} />
          <Text className="text-sm text-faint">How-To</Text>
        </Pressable>
        {kindMenu}
      </View>
    );
  }

  // Note → inline editable short text (writes to docs.body); plain text when
  // not editable (see the doc comment above — an org-wide duty from another
  // chapter can't write this chapter's own `docs.update`).
  if (doc.kind === "note") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon name="file-text" size={13} color={colors.faint} />
        {editable ? (
          <InlineText
            value={doc.body ?? ""}
            placeholder="Note…"
            onCommit={(t) =>
              void updateDoc({ docId: doc._id, body: t }).catch(alertError)
            }
          />
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-ink" numberOfLines={1}>
            {doc.body || "—"}
          </Text>
        )}
        {editable ? kindMenu : null}
      </View>
    );
  }

  // Link / Video → inline editable URL + open-out; plain text + open-out
  // when not editable (opening is a read, editing the URL is a write).
  if (doc.kind === "link" || doc.kind === "video") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon
          name={doc.kind === "video" ? "video" : "link"}
          size={13}
          color={colors.faint}
        />
        {editable ? (
          <InlineText
            value={doc.url ?? ""}
            placeholder={doc.kind === "video" ? "Video URL" : "Link URL"}
            onCommit={(t) =>
              void updateDoc({ docId: doc._id, url: t.trim() }).catch(alertError)
            }
          />
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-ink" numberOfLines={1}>
            {doc.url || "—"}
          </Text>
        )}
        {doc.url ? (
          <Pressable
            hitSlop={6}
            onPress={() => Linking.openURL(doc.url as string)}
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="external-link" size={14} color={colors.accent} />
          </Pressable>
        ) : null}
        {editable ? kindMenu : null}
      </View>
    );
  }

  // Markdown → title + open the doc editor page. Viewing stays available
  // either way (a read); only the kind menu (a write) is gated.
  return (
    <View className="flex-1 flex-row items-center px-1">
      <Pressable
        onPress={() =>
          router.push(
            `/doc/${doc._id}?from=${encodeURIComponent(pathname)}` as any,
          )
        }
        className="flex-1 flex-row items-center justify-between gap-2 px-1 py-1.5 active:bg-sunken web:hover:bg-sunken"
      >
        <View className="flex-1 flex-row items-center gap-1.5">
          <Icon name="book-open" size={14} color={colors.muted} />
          <Text className="text-sm text-ink" numberOfLines={1}>
            {doc.title || "Untitled"}
          </Text>
        </View>
        <Icon name="chevron-right" size={15} color={colors.faint} />
      </Pressable>
      {editable ? kindMenu : null}
    </View>
  );
}
