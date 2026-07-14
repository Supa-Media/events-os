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
import { Icon, ToastView } from "../ui";
import { colors } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { AssistantFab, MessageRow } from "./shared";
import { ChatModelSettings } from "./ChatModelSettings";

/**
 * Chapter-scoped clone of {@link AiAssistantPanel}, docked to the Inventory
 * page. Same reactive `aiMessages` feed, same FAB, same Undo/budget footer — it
 * just drives the INVENTORY thread (keyed off the chapter, not an event): it
 * ensures/creates an inventory thread and runs `runInventoryAssistant`, which
 * edits the chapter's asset registry (tags, quantities, condition, …). Free
 * models only, so the spend readout reads ~$0.
 */

const SUGGESTIONS = [
  "Tag all the mics as audio",
  "Add 4 XLR cables",
  "Mark the batteries as consumable",
];

export function InventoryAssistantPanel() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [reverting, setReverting] = useState(false);

  const ensureThread = useMutation(api.ai.ensureInventoryThread);
  const newThread = useMutation(api.ai.newInventoryThread);
  const run = useAction(api.aiActions.runInventoryAssistant);
  const revert = useMutation(api.ai.revertAiRun);

  const messages = useQuery(
    api.ai.listMessages,
    threadId ? { threadId: threadId as any } : "skip",
  );
  const budget = useQuery(api.ai.budgetStatus);
  const chatSettings = useQuery(
    api.ai.threadAiSettings,
    threadId ? { threadId: threadId as any } : "skip",
  );
  // Inventory runs carry no eventId — find the most recent one on this thread.
  const runs = useQuery(api.ai.listRuns, {});

  const scrollRef = useRef<ScrollView>(null);
  const { run: runAction, toast, dismiss } = useActionRunner();

  // Create/find the chapter's inventory thread the first time the panel opens.
  useEffect(() => {
    if (open && !threadId) {
      void runAction(() => ensureThread({}), {
        errorTitle: "Couldn't open the assistant",
        onSuccess: (id) => setThreadId(id as string),
      });
    }
  }, [open, threadId, ensureThread, runAction]);

  // Keep the feed pinned to the latest message.
  useEffect(() => {
    if (messages?.length) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages?.length]);

  const lastRun = runs?.find((r: any) => r.threadId === threadId);
  const canUndo =
    !!lastRun && lastRun.status === "done" && lastRun.revertableCount > 0;

  async function send(text: string) {
    const body = text.trim();
    if (!body || busy) return;
    setInput("");
    setBusy(true);
    try {
      let tid = threadId;
      if (!tid) {
        tid = (await ensureThread({})) as string;
        setThreadId(tid);
      }
      await run({ threadId: tid as any, userText: body });
    } catch {
      // Errors are streamed into the thread as error messages; nothing to do.
    } finally {
      setBusy(false);
    }
  }

  async function handleNewChat() {
    await runAction(() => newThread({}), {
      errorTitle: "Couldn't start a new chat",
      onSuccess: (id) => setThreadId(id as string),
    });
  }

  async function handleUndo() {
    if (!lastRun) return;
    setReverting(true);
    try {
      await revert({ runId: lastRun._id as any });
    } catch {
    } finally {
      setReverting(false);
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
          Assistant · Inventory
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
              How can I help with your inventory?
            </Text>
            <Text className="text-2xs text-faint">
              I can add assets, tag them, set quantities and condition — and
              chain several changes in one go. Try:
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

      {/* Undo + budget */}
      <View className="gap-1 border-t border-border px-3 pt-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xs text-faint">
            {budget?.over
              ? `Budget reached (${budget.over})`
              : `Spend (30d): $${budget?.user.spent.toFixed(2) ?? "0.00"}`}
          </Text>
          {canUndo ? (
            <Pressable
              onPress={handleUndo}
              disabled={reverting}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Icon name="refresh-ccw" size={12} color={colors.accent} />
              <Text className="text-2xs font-semibold text-accent">
                {reverting
                  ? "Reverting…"
                  : `Undo last (${lastRun?.revertableCount})`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* Per-chat model + spend limit (any free model for all; paid + caps for
            super admins). */}
        <ChatModelSettings
          threadId={threadId}
          settings={chatSettings}
        />
      </View>

      {/* Input */}
      <View className="flex-row items-end gap-2 px-3 pb-3 pt-2">
        <View className="flex-1 rounded-xl border border-border bg-surface px-3 py-2">
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Do anything with AI…"
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
            backgroundColor: input.trim() && !busy ? colors.accent : colors.borderStrong,
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
