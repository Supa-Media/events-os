import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon, Select, ToastView } from "../ui";
import { colors } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { AssistantFab, MessageRow, errorMessage } from "./shared";

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
  const { run: runAction, toast, dismiss } = useActionRunner();

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
      void runAction(() => ensureDocThread({ docId: docId as any }), {
        errorTitle: "Couldn't open the assistant",
        onSuccess: (id) => {
          setThreadId(id as string);
          setTargetDocId(docId);
        },
      });
    }
  }, [open, threadId, docId, resolveTargetDocId, ensureDocThread, runAction]);

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
    const did = targetDocId ?? docId;
    await runAction(() => newDocThread({ docId: did as any }), {
      errorTitle: "Couldn't start a new chat",
      onSuccess: (id) => setThreadId(id as string),
    });
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
    return <AssistantFab onPress={() => setOpen(true)} />;
  }

  // ── Open: docked side panel (in-flow column — squeezes the page content) ─────
  return (
    <View
      className="h-full border-l border-border bg-raised"
      style={{ width: 380 }}
    >
      <ToastView toast={toast} onDismiss={dismiss} />
      {/* Header */}
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon name="sparkles" size={16} color={colors.accent} />
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
              Chat with me to write or revise this how-to. I can research the web
              and reuse your team's existing guides, then write it out so a
              brand-new volunteer could follow it. Try:
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
          messages.map((m: any) => (
            <MessageRow
              key={m._id}
              m={m}
              toolResultLines={2}
              compactArgsValueLen={40}
            />
          ))
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
