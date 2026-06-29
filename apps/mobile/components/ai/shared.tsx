import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { ConvexError } from "convex/values";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Shared building blocks for the two AI assistant panels (`AiAssistantPanel`
 * for events, `DocAssistantPanel` for How-To docs). Both render the SAME
 * reactive `aiMessages` feed (user / assistant / reasoning / tool_call /
 * tool_result / error) and the SAME floating action button, so those pieces
 * live here once. Panel-specific chrome (header title, budget/Undo footer,
 * input) stays in each panel.
 */

/** Pull a user-facing message out of any thrown error. */
export function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

/**
 * The floating "open assistant" button, shown when the panel is closed.
 * Identical across both panels.
 */
export function AssistantFab({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
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
      <Icon name="sparkles" size={22} color={colors.accentText} />
    </Pressable>
  );
}

/**
 * One message in the feed, rendered by kind. `toolResultLines` caps the
 * tool_result text (the doc panel clamps to 2 lines; the event panel doesn't).
 */
export function MessageRow({
  m,
  toolResultLines,
  compactArgsValueLen,
}: {
  m: any;
  toolResultLines?: number;
  /** Per-value char cap for tool_call args (doc panel clamps so a markdown body isn't dumped). */
  compactArgsValueLen?: number;
}) {
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

  if (m.kind === "reasoning") {
    return <Reasoning text={m.text ?? ""} />;
  }

  if (m.kind === "tool_call") {
    const args = m.toolArgs ? compactArgs(m.toolArgs, compactArgsValueLen) : "";
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-lg bg-sunken px-2 py-1">
        <Icon name="tool" size={11} color={colors.muted} />
        <Text className="text-2xs font-semibold text-muted">{m.toolName}</Text>
        {args ? <Text className="text-2xs text-faint">{args}</Text> : null}
      </View>
    );
  }

  if (m.kind === "tool_result") {
    return (
      <View className="flex-row items-center gap-1.5 self-start pl-2">
        <Icon
          name={m.toolOk ? "check" : "alert-circle"}
          size={11}
          color={m.toolOk ? colors.success : colors.danger}
        />
        <Text
          className="text-2xs"
          style={{ color: m.toolOk ? colors.success : colors.danger }}
          numberOfLines={toolResultLines}
        >
          {m.text}
        </Text>
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

/** Collapsible reasoning trace — collapsed by default, tap to expand. */
function Reasoning({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable
      onPress={() => setExpanded((e) => !e)}
      className="self-start rounded-lg bg-sunken px-2.5 py-1.5 active:opacity-70"
      style={{ maxWidth: "92%" }}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon name="cpu" size={11} color={colors.faint} />
        <Text className="text-2xs font-semibold text-faint">
          Reasoning {expanded ? "▾" : "▸"}
        </Text>
      </View>
      {expanded ? (
        <Text className="mt-1 text-2xs italic text-muted">{text}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Compact one-line render of a tool call's args. Each value is itself clamped
 * to `maxValueLen` chars (the doc panel passes a small cap so a whole markdown
 * `write_doc` body isn't dumped inline); the joined string is then clamped too.
 */
function compactArgs(
  args: Record<string, unknown>,
  maxValueLen = Infinity,
): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      const short =
        val.length > maxValueLen ? val.slice(0, maxValueLen - 1) + "…" : val;
      return `${k}=${short}`;
    });
  const s = parts.join(", ");
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
