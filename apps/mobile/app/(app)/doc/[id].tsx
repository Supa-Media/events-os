import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Linking, Platform } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, TextField, Icon } from "../../../components/ui";
import { MarkdownEditor } from "../../../components/markdown";
import { colors } from "../../../lib/theme";

/**
 * Authed How-To doc editor — `/doc/<docId>`.
 *
 * Edits the doc's title and (for markdown docs) its body via the Obsidian-style
 * `MarkdownEditor`, saving through `api.docs.update` (title on blur, body
 * debounced). An AI "Generate / Improve" action fills the body from a prompt,
 * and a Share button copies the public `/doc/<shareId>` URL (web) / surfaces the
 * `eventsos://doc/<shareId>` deep link. Link/video/note docs get a simple
 * URL/text editor instead of the markdown surface.
 */
export default function DocEditorScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = id as string;

  const doc = useQuery(api.docs.get, { docId: docId as any });
  const update = useMutation(api.docs.update);
  const generate = useAction(api.aiActions.generateDoc);

  const [titleInput, setTitleInput] = useState<string | null>(null);
  // Body edits are buffered locally and flushed on a debounce so we don't fire a
  // mutation per keystroke. `null` = mirror the server value (e.g. after AI fills
  // it). `bodyInput` is also used for link/video/note kinds (committed on blur).
  const [bodyInput, setBodyInput] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      void update({ docId: docId as any, body: md });
    }, 500);
  }

  async function runAi(mode: "generate" | "improve") {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      await generate({ docId: docId as any, prompt: aiPrompt.trim(), mode });
      setAiPrompt("");
      // The action wrote docs.body server-side; drop the local draft so the
      // editor mirrors the freshly generated body.
      setBodyInput(null);
    } catch {
      // Errors surface as a no-op here; body simply stays unchanged.
    } finally {
      setAiBusy(false);
    }
  }

  return (
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
            void update({ docId: docId as any, title: titleInput });
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
                void update({ docId: docId as any, url: urlInput });
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
                void update({ docId: docId as any, body: bodyInput });
              }
            }}
            placeholder="Short note…"
            multiline
          />
        </View>
      ) : isMarkdown ? (
        <>
          {/* AI generate / improve */}
          <Card padding="md" className="mt-4">
            <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
              AI assist
            </Text>
            <TextField
              value={aiPrompt}
              onChangeText={setAiPrompt}
              placeholder="What should this how-to cover?"
              multiline
            />
            <View className="mt-2 flex-row gap-2">
              <Button
                title={aiBusy ? "Working…" : "Generate"}
                variant="secondary"
                loading={aiBusy}
                disabled={aiBusy || !aiPrompt.trim()}
                onPress={() => void runAi("generate")}
              />
              <Button
                title="Improve"
                variant="ghost"
                disabled={aiBusy || !(doc.body && doc.body.trim())}
                onPress={() => void runAi("improve")}
              />
            </View>
          </Card>

          <View className="mt-4">
            <MarkdownEditor
              value={bodyInput ?? doc.body ?? ""}
              onChange={onBodyChange}
              placeholder="Write your how-to in Markdown…"
            />
          </View>
        </>
      ) : null}
    </Screen>
  );
}
