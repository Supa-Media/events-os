import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Linking, Platform } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, TextField, Icon } from "../../../components/ui";
import { MarkdownEditor } from "../../../components/markdown";
import { DocAssistantPanel } from "../../../components/ai/DocAssistantPanel";
import { colors } from "../../../lib/theme";

/**
 * Authed How-To doc editor — `/doc/<docId>`.
 *
 * Edits the doc's title and (for markdown docs) its body via the Obsidian-style
 * `MarkdownEditor`, saving through `api.docs.update` (title on blur, body
 * debounced). For markdown docs, a floating Notion-AI-style `DocAssistantPanel`
 * docks to the right: the user chats with an agent that rewrites the doc's
 * markdown. A Share button copies the public `/doc/<shareId>` URL (web) /
 * surfaces the `eventsos://doc/<shareId>` deep link. Link/video/note docs get a
 * simple URL/text editor instead of the markdown surface.
 */
export default function DocEditorScreen() {
  const router = useRouter();
  const { id, ownerItem, ownerCol } = useLocalSearchParams<{
    id: string;
    ownerItem?: string;
    ownerCol?: string;
  }>();

  // The doc currently being edited. Starts at the route id, but a copy-on-write
  // fork (see `maybeForkThenUpdate`) repoints it at the freshly forked copy so
  // all reads/writes from then on target the copy, not the shared master.
  const [activeDocId, setActiveDocId] = useState<string>(id as string);
  // Guard against double-forking (and concurrent fork calls) within a session.
  const hasForkedRef = useRef(false);
  const forkingRef = useRef(false);

  const doc = useQuery(api.docs.get, { docId: activeDocId as any });
  const update = useMutation(api.docs.update);
  const fork = useMutation(api.docs.forkForEventItem);

  const [titleInput, setTitleInput] = useState<string | null>(null);
  // Body edits are buffered locally and flushed on a debounce so we don't fire a
  // mutation per keystroke. `null` = mirror the server value (e.g. after the AI
  // panel rewrites it). `bodyInput` is also used for link/video/note kinds
  // (committed on blur).
  const [bodyInput, setBodyInput] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bodySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Copy-on-write: when editing a SHARED (template-origin) doc from an event
  // context, fork once into an event-local copy before applying the patch.
  // Otherwise (template editor, or a doc already `scope === "event"`, or already
  // forked this session) apply the patch in place. Handles the write itself so
  // callers don't double-write. Returns the doc id the patch landed on (useful
  // for follow-up actions like the AI generate that must target the same copy).
  async function maybeForkThenUpdate(patch: {
    title?: string;
    url?: string;
    body?: string;
  }): Promise<string> {
    const shouldFork =
      !!ownerItem &&
      !!ownerCol &&
      !hasForkedRef.current &&
      !forkingRef.current &&
      doc != null &&
      doc.scope !== "event";
    if (shouldFork) {
      forkingRef.current = true;
      try {
        const res = await fork({
          docId: activeDocId as any,
          eventItemId: ownerItem as any,
          colKey: ownerCol as string,
        });
        hasForkedRef.current = true;
        setActiveDocId(res._id);
        router.replace(
          `/doc/${res._id}?ownerItem=${ownerItem}&ownerCol=${encodeURIComponent(
            ownerCol as string,
          )}` as any,
        );
        await update({ docId: res._id as any, ...patch });
        return res._id;
      } finally {
        forkingRef.current = false;
      }
    }
    await update({ docId: activeDocId as any, ...patch });
    return activeDocId;
  }

  // Flush any pending debounced body save on unmount.
  useEffect(
    () => () => {
      if (bodySaveTimer.current) clearTimeout(bodySaveTimer.current);
    },
    [],
  );

  if (doc === undefined) return <Screen loading />;
  if (doc === null) {
    return (
      <Screen>
        <Text className="text-base text-muted">This document isn't available.</Text>
      </Screen>
    );
  }

  const title = titleInput ?? doc.title;
  const isMarkdown = doc.kind === "markdown";
  const isNote = doc.kind === "note";
  const isLinkLike = doc.kind === "link" || doc.kind === "video";

  // The public share targets.
  const webUrl =
    Platform.OS === "web" && typeof window !== "undefined"
      ? `${window.location.origin}/doc/${doc.shareId}`
      : `/doc/${doc.shareId}`;
  const deepLink = `eventsos://doc/${doc.shareId}`;

  async function share() {
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(webUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
        return;
      } catch {
        // fall through to opening the link
      }
    }
    void Linking.openURL(webUrl).catch(() => {});
  }

  function onBodyChange(md: string) {
    setBodyInput(md);
    if (bodySaveTimer.current) clearTimeout(bodySaveTimer.current);
    bodySaveTimer.current = setTimeout(() => {
      void maybeForkThenUpdate({ body: md });
    }, 500);
  }

  return (
    <View className="flex-1 flex-row">
    <View className="flex-1">
    <Screen maxWidth={820}>
      <Stack.Screen options={{ title: doc.title || "Doc" }} />

      {/* Header: back + title + share */}
      <View className="mb-4 flex-row items-center gap-2">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          className="rounded-md p-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="arrow-left" size={18} color={colors.muted} />
        </Pressable>
        <Text className="text-xs font-bold uppercase tracking-wider text-faint">
          {doc.kind} doc
        </Text>
        <View className="flex-1" />
        <Pressable
          onPress={share}
          className="flex-row items-center gap-1.5 rounded-md border border-border px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name={copied ? "check" : "share-2"} size={14} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">
            {copied ? "Copied" : "Share"}
          </Text>
        </Pressable>
      </View>

      {/* Title */}
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitleInput}
        onBlur={() => {
          if (titleInput != null && titleInput !== doc.title) {
            void maybeForkThenUpdate({ title: titleInput });
          }
        }}
        placeholder="Untitled"
      />

      <View className="mt-2">
        <Text className="text-2xs text-faint">Public link · {webUrl}</Text>
        <Text className="text-2xs text-faint">Deep link · {deepLink}</Text>
      </View>

      {/* Body editor by kind */}
      {isLinkLike ? (
        <View className="mt-4">
          <TextField
            label={doc.kind === "video" ? "Video URL" : "Link URL"}
            value={urlInput ?? doc.url ?? ""}
            onChangeText={setUrlInput}
            onBlur={() => {
              if (urlInput != null && urlInput !== (doc.url ?? "")) {
                void maybeForkThenUpdate({ url: urlInput });
              }
            }}
            placeholder="https://…"
          />
        </View>
      ) : isNote ? (
        <View className="mt-4">
          <TextField
            label="Note"
            value={bodyInput ?? doc.body ?? ""}
            onChangeText={setBodyInput}
            onBlur={() => {
              if (bodyInput != null && bodyInput !== (doc.body ?? "")) {
                void maybeForkThenUpdate({ body: bodyInput });
              }
            }}
            placeholder="Short note…"
            multiline
          />
        </View>
      ) : isMarkdown ? (
        <View className="mt-4">
          <MarkdownEditor
            value={bodyInput ?? doc.body ?? ""}
            onChange={onBodyChange}
            placeholder="Write your how-to in Markdown…"
          />
        </View>
      ) : null}
    </Screen>
    </View>

    {/* In-flow Notion-AI-style chat panel — markdown docs only. Docks right and
        squeezes the content left when open; chats with an agent that rewrites
        the doc body. COW is honored via `resolveTargetDocId`, which forks a
        shared template doc into an event-local copy before the first edit. */}
    {isMarkdown ? (
      <DocAssistantPanel
        docId={activeDocId}
        docTitle={doc.title}
        resolveTargetDocId={
          ownerItem && ownerCol
            ? () => maybeForkThenUpdate({})
            : undefined
        }
        onEdited={() => setBodyInput(null)}
      />
    ) : null}
    </View>
  );
}
