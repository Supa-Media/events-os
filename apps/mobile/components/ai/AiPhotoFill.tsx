import { useState } from "react";
import { View, Text } from "react-native";
import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Select } from "../ui";

/**
 * "Auto-fill photos" agent trigger for an event's Supplies section.
 *
 * Runs the `fillSupplyPhotos` agent, shows a result line + one-click Undo (which
 * reverts every photo the run set), and a compact rolling-30-day budget readout.
 * Surfaces NO_OPENROUTER_KEY / AI_BUDGET ConvexErrors inline (it never crashes).
 */

/** Pull a human message out of a thrown ConvexError, or a generic fallback. */
function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | undefined;
    if (data?.message) return data.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong running the agent.";
}

type Result =
  | { kind: "filled"; runId: string; filled: number; total: number; costUsd: number }
  | { kind: "reverted" }
  | { kind: "error"; message: string };

export function AiPhotoFill({ eventId }: { eventId: string }) {
  const run = useAction(api.aiActions.fillSupplyPhotos);
  const revert = useMutation(api.ai.revertAiRun);
  const budget = useQuery(api.ai.budgetStatus);
  const cfg = useQuery(api.ai.aiConfig);
  const setActiveModel = useMutation(api.ai.setActiveModel);

  const [busy, setBusy] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  const over = budget?.over ?? null;
  const disabled = busy || reverting || !!over;

  const activeModelLabel =
    cfg?.models.find((m) => m.slug === cfg.activeModel)?.label ??
    cfg?.activeModel;

  async function handleModelChange(slug: string) {
    setModelError(null);
    try {
      await setActiveModel({ slug });
    } catch (err) {
      setModelError(errorMessage(err));
    }
  }

  async function handleRun() {
    setBusy(true);
    setResult(null);
    try {
      const res = await run({ eventId: eventId as any });
      setResult({ kind: "filled", ...res });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo(runId: string) {
    setReverting(true);
    try {
      await revert({ runId: runId as any });
      setResult({ kind: "reverted" });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setReverting(false);
    }
  }

  return (
    <View className="items-end gap-1.5">
      <View className="flex-row items-center gap-2">
        {result?.kind === "filled" ? (
          <Button
            title="Undo"
            icon="refresh-ccw"
            size="sm"
            variant="secondary"
            loading={reverting}
            onPress={() => handleUndo(result.runId)}
          />
        ) : null}
        <Button
          title="✨ Auto-fill photos"
          icon="zap"
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={disabled}
          onPress={handleRun}
        />
      </View>

      {busy ? (
        <Text className="text-2xs text-faint">Searching the web… this can take a bit.</Text>
      ) : result?.kind === "filled" ? (
        <Text className="text-2xs font-semibold text-ink">
          Filled {result.filled}/{result.total} photos · ${result.costUsd.toFixed(2)}
        </Text>
      ) : result?.kind === "reverted" ? (
        <Text className="text-2xs text-muted">Reverted</Text>
      ) : result?.kind === "error" ? (
        <Text className="text-2xs text-danger">{result.message}</Text>
      ) : null}

      {budget ? (
        <Text className={`text-2xs ${over ? "font-semibold text-danger" : "text-faint"}`}>
          {over
            ? `AI budget reached (${over})`
            : `AI spend (30d): $${budget.user.spent.toFixed(2)} / $${budget.user.cap}`}
        </Text>
      ) : null}

      {cfg ? (
        cfg.isSuperuser ? (
          <View className="w-44 items-stretch gap-1">
            <Select
              value={cfg.activeModel}
              options={cfg.models.map((m) => ({ value: m.slug, label: m.label }))}
              onChange={handleModelChange}
            />
            {modelError ? (
              <Text className="text-2xs text-danger">{modelError}</Text>
            ) : null}
          </View>
        ) : (
          <Text className="text-2xs text-muted">Model: {activeModelLabel}</Text>
        )
      ) : null}
    </View>
  );
}
