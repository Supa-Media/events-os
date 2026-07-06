/**
 * HowToDocCell — the Responsibilities grid's How-To editor, backed by the
 * SAME `docs` primitive as event-grid How-To cells: a duty's runbook can be
 * an external link, a video, a short inline note, or a full markdown page
 * with its own route and share URL. No copy-on-write here — responsibility
 * docs are shared masters, edited in place.
 *
 * Legacy plain-text `howTo` strings (pre-doc rows) keep rendering as an
 * inline text editor until a doc kind is picked, which supersedes them.
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
  legacyText,
  editable = true,
  onSetDoc,
  onLegacyCommit,
}: {
  doc: HowToDocSummary | null;
  legacyText?: string | null;
  editable?: boolean;
  onSetDoc: (docId: Id<"docs"> | null) => void;
  onLegacyCommit?: (text: string) => void;
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
        // Carry legacy text into the note body so nothing typed is lost.
        title: "Untitled",
        body: kind === "note" ? (legacyText ?? undefined) : undefined,
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

  // No doc yet → legacy text editor (if any text) with a "+" to upgrade, or
  // the plain "+ How-To" affordance.
  if (!doc) {
    if (legacyText != null && legacyText !== "" && onLegacyCommit) {
      return (
        <View className="flex-1 flex-row items-center gap-1 px-1">
          <InlineText
            value={legacyText}
            placeholder="Steps, links, tools…"
            onCommit={onLegacyCommit}
          />
          {kindMenu}
        </View>
      );
    }
    return (
      <View className="flex-1 flex-row items-center px-1">
        <Pressable
          onPress={editable ? open : undefined}
          className="flex-1 flex-row items-center gap-1 px-1 py-1.5 active:opacity-70"
        >
          <Icon name="plus" size={13} color={colors.faint} />
          <Text className="text-sm text-faint">How-To</Text>
        </Pressable>
        {kindMenu}
      </View>
    );
  }

  // Note → inline editable short text (writes to docs.body).
  if (doc.kind === "note") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon name="file-text" size={13} color={colors.faint} />
        <InlineText
          value={doc.body ?? ""}
          placeholder="Note…"
          onCommit={(t) =>
            void updateDoc({ docId: doc._id, body: t }).catch(alertError)
          }
        />
        {kindMenu}
      </View>
    );
  }

  // Link / Video → inline editable URL + open-out.
  if (doc.kind === "link" || doc.kind === "video") {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-1">
        <Icon
          name={doc.kind === "video" ? "video" : "link"}
          size={13}
          color={colors.faint}
        />
        <InlineText
          value={doc.url ?? ""}
          placeholder={doc.kind === "video" ? "Video URL" : "Link URL"}
          onCommit={(t) =>
            void updateDoc({ docId: doc._id, url: t.trim() }).catch(alertError)
          }
        />
        {doc.url ? (
          <Pressable
            hitSlop={6}
            onPress={() => Linking.openURL(doc.url as string)}
            className="rounded p-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="external-link" size={14} color={colors.accent} />
          </Pressable>
        ) : null}
        {kindMenu}
      </View>
    );
  }

  // Markdown → title + open the doc editor page.
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
      {kindMenu}
    </View>
  );
}
