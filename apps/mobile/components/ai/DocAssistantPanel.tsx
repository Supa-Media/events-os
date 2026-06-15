import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon, Select } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Floating, Notion-AI-style assistant docked to the How-To doc editor.
 *
 * The doc-page counterpart to `AiAssistantPanel`: instead of editing event
 * items via a tool loop, the user chats with the assistant which rewrites the
 * doc's markdown body. The thread is a reactive feed of `aiMessages`, so the
 * user/assistant turns (and any errors) stream in live. There's no item-level
 * revert here — the markdown editor itself is the undo. Free models only, so
 * the spend readout reads ~$0.
 *
 * Copy-on-write: when `resolveTargetDocId` is provided, the FIRST send resolves
 * the real doc id to edit (forking a shared template doc into an event-local
 * copy when needed) and uses that id for the thread + every run this session.
 * For template editing, `resolveTargetDocId` is omitted and `docId` is used.
 */

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

const SUGGESTIONS = [
  "Draft a setup checklist",
  "Make this more concise",
  "Add a troubleshooting section",
];

export function DocAssistantPanel({
  docId,
  docTitle,
  resolveTargetDocId,
  onEdited,
}: {
  docId: string;
  docTitle: string;
  /**
   * Resolve the doc id to actually edit (copy-on-write fork when needed).
   * Omitted for template editing — `docId` is used directly.
   */
  resolveTargetDocId?: () => Promise<string>;
  /** Called after a run that edited the doc body, so the editor can refresh. */
  onEdited?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [targetDocId, setTargetDocId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const ensureDocThread = useMutation(api.ai.ensureDocThread);
  const newDocThread = useMutation(api.ai.newDocThread);
  const run = useAction(api.aiActions.runDocAssistant);
  const setActiveModel = useMutation(api.ai.setActiveModel);

  const messages = useQuery(
    api.ai.listMessages,
    threadId ? { threadId: threadId as any } : "skip",
  );
  const budget = useQuery(api.ai.budgetStatus);
  const cfg = useQuery(api.ai.aiConfig);

  const scrollRef = useRef<ScrollView>(null);

  // Keep the feed pinned to the latest message.
  useEffect(() => {
    if (messages?.length) {
      requestAnimationFrame(() =>
        scrollRef.current?.scrollToEnd({ animated: true }),
      );
    }
  }, [messages?.length]);

  const activeModelLabel =
    cfg?.models.find((m) => m.slug === cfg.activeModel)?.label ??
    cfg?.activeModel;

  /**
   * Resolve (once) the doc id this session edits: the COW-forked copy if a
   * resolver is provided, otherwise the passed `docId`. The thread is keyed to
   * the SAME id, so the conversation and edits target one consistent doc.
   */
  async function resolveSessionDoc(): Promise<{ tid: string; did: string }> {
    let did = targetDocId;
    if (!did) {
      did = resolveTargetDocId ? await resolveTargetDocId() : docId;
      setTargetDocId(did);
    }
    let tid = threadId;
    if (!tid) {
      tid = (await ensureDocThread({ docId: did as any })) as string;
      setThreadId(tid);
    }
    return { tid, did };
  }

  // Open the thread eagerly when the panel opens, so the feed shows history.
  // Only safe to pre-resolve when there's no COW fork to defer to first send.
  useEffect(() => {
    if (open && !threadId && !resolveTargetDocId) {
      ensureDocThread({ docId: docId as any })
        .then((id) => {
          setThreadId(id as string);
          setTargetDocId(docId);
        })
        .catch(() => {});
    }
  }, [open, threadId, docId, resolveTargetDocId, ensureDocThread]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || busy) return;
    setInput("");
    setBusy(true);
    try {
      const { tid, did } = await resolveSessionDoc();
      const res = await run({
        threadId: tid as any,
        docId: did as any,
        userText: body,
      });
      if (res?.edited) onEdited?.();
    } catch {
      // Errors are streamed into the thread as error messages; nothing to do.
    } finally {
      setBusy(false);
    }
  }

  async function handleNewChat() {
    try {
      const did = targetDocId ?? docId;
      const id = (await newDocThread({ docId: did as any })) as string;
      setThreadId(id);
    } catch {}
  }

  async function handleModelChange(slug: string) {
    setModelError(null);
    try {
      await setActiveModel({ slug });
    } catch (err) {
      setModelError(errorMessage(err));
    }
  }

  // ── Closed: floating action button ─────────────────────────────────────────
  if (!open) {
    return (
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        className="absolute bottom-6 right-6 active:opacity-80"
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Icon name="zap" size={22} color={colors.accentText} />
      </Pressable>
    );
  }

  // ── Open: docked side panel ─────────────────────────────────────────────────
  return (
    <View
      className="absolute bottom-0 right-0 top-0 border-l border-border bg-raised"
      style={{
        width: 380,
        shadowColor: "#000",
        shadowOpacity: 0.12,
        shadowRadius: 16,
      }}
    >
      {/* Header */}
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon name="zap" size={16} color={colors.accent} />
        <Text className="flex-1 text-sm font-bold text-ink" numberOfLines={1}>
          Assistant · {docTitle}
        </Text>
        <Pressable onPress={handleNewChat} className="active:opacity-70 p-1">
          <Icon name="plus" size={16} color={colors.muted} />
        </Pressable>
        <Pressable onPress={() => setOpen(false)} className="active:opacity-70 p-1">
          <Icon name="x" size={16} color={colors.muted} />
        </Pressable>
      </View>

      {/* Feed */}
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ padding: 12, gap: 8 }}
      >
        {!messages || messages.length === 0 ? (
          <View className="gap-2 py-4">
            <Text className="text-sm font-semibold text-ink">
              How can I help with this how-to?
            </Text>
            <Text className="text-2xs text-faint">
              Chat with me to write or revise this document — I'll rewrite the
              markdown for you. Try:
            </Text>
            {SUGGESTIONS.map((s) => (
              <Pressable
                key={s}
                onPress={() => send(s)}
                className="rounded-lg border border-border bg-surface px-3 py-2 active:opacity-70"
              >
                <Text className="text-xs text-muted">{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          messages.map((m: any) => <MessageRow key={m._id} m={m} />)
        )}
        {busy ? (
          <View className="flex-row items-center gap-2 py-1">
            <ActivityIndicator size="small" color={colors.accent} />
            <Text className="text-2xs text-faint">Thinking…</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Budget + model */}
      <View className="gap-1 border-t border-border px-3 pt-2">
        <Text className="text-2xs text-faint">
          {budget?.over
            ? `Budget reached (${budget.over})`
            : `Spend (30d): $${budget?.user.spent.toFixed(2) ?? "0.00"}`}
        </Text>

        {cfg ? (
          cfg.isSuperuser ? (
            <View className="gap-1 pb-1">
              <Select
                value={cfg.activeModel}
                options={cfg.models.map((m) => ({
                  value: m.slug,
                  label: m.label,
                }))}
                onChange={handleModelChange}
              />
              {modelError ? (
                <Text className="text-2xs text-danger">{modelError}</Text>
              ) : null}
            </View>
          ) : (
            <Text className="text-2xs text-faint">Model: {activeModelLabel}</Text>
          )
        ) : null}
      </View>

      {/* Input */}
      <View className="flex-row items-end gap-2 px-3 pb-3 pt-2">
        <View className="flex-1 rounded-xl border border-border bg-surface px-3 py-2">
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask me to edit this doc…"
            placeholderTextColor={colors.faint}
            multiline
            onSubmitEditing={() => send(input)}
            blurOnSubmit
            className="text-sm text-ink"
            style={{ maxHeight: 96, outlineWidth: 0 } as any}
          />
        </View>
        <Pressable
          onPress={() => send(input)}
          disabled={busy || !input.trim()}
          className="active:opacity-80"
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor:
              input.trim() && !busy ? colors.accent : colors.borderStrong,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="send" size={16} color={colors.accentText} />
        </Pressable>
      </View>
    </View>
  );
}

/** One message in the feed, rendered by kind. */
function MessageRow({ m }: { m: any }) {
  if (m.kind === "user") {
    return (
      <View className="max-w-[85%] self-end rounded-2xl rounded-br-sm bg-accent px-3 py-2">
        <Text className="text-sm" style={{ color: colors.accentText }}>
          {m.text}
        </Text>
      </View>
    );
  }

  if (m.kind === "assistant") {
    return (
      <View className="max-w-[90%] self-start rounded-2xl rounded-bl-sm border border-border bg-surface px-3 py-2">
        <Text className="text-sm text-ink">{m.text}</Text>
      </View>
    );
  }

  if (m.kind === "error") {
    return (
      <View className="self-start rounded-lg border border-danger/40 bg-dangerBg px-3 py-2">
        <Text className="text-2xs text-danger">{m.text}</Text>
      </View>
    );
  }

  return null;
}
