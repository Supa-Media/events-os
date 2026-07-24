/**
 * RECEIPTS TAB — "Re-extract failed" control: the mobile hook for
 * `api.receipts.retryFailedExtractions`, the throttled bulk re-extraction
 * sweep. Backend context: a mass upload (~80 receipts) once scheduled every
 * extraction at once and tripped Ollama's rate limit, leaving a pile of
 * receipts with `ocrError` set ("Extraction failed"). This bar surfaces that
 * backlog (`api.receipts.failedExtractionStatus`) and starts the SERIAL,
 * throttled sweep that clears it without re-tripping the same rate limit.
 *
 * SAME model-override affordance as `ReceiptDetailModal`'s single-receipt
 * retry (a small "Model override…" toggle + text field) — a bookkeeper who
 * knows the configured model is the problem can point the whole sweep at a
 * different one in one shot.
 *
 * Progress is entirely reactive: `failedExtractionStatus` and `listReceipts`
 * are live queries, so as the sweep clears receipts one at a time, this
 * bar's count (and each card's "Extraction failed" badge in the Library
 * section below) update on their own — no polling here.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, TextField } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";

export function RetryFailedBar({ run }: { run: ActionRunner["run"] }) {
  const status = useQuery(api.receipts.failedExtractionStatus, {});
  const retryFailedExtractions = useMutation(api.receipts.retryFailedExtractions);

  const [starting, setStarting] = useState(false);
  const [showModelInput, setShowModelInput] = useState(false);
  const [modelOverride, setModelOverride] = useState("");

  if (!status || status.failedCount === 0) return null;

  const busy = starting || status.sweepInProgress;

  async function handleStart() {
    setStarting(true);
    await run(
      () =>
        retryFailedExtractions({
          model: modelOverride.trim() ? modelOverride.trim() : undefined,
        }),
      { errorTitle: "Couldn't start the re-extract sweep" },
    );
    setStarting(false);
  }

  return (
    <View className="mb-4 gap-1.5 rounded-xl border border-warn bg-warn-bg px-4 py-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="flex-1 text-sm font-semibold text-warn">
          {status.failedCount} receipt{status.failedCount === 1 ? "" : "s"} failed extraction
        </Text>
        <Button
          title={
            status.sweepInProgress
              ? "Re-extracting…"
              : `Re-extract failed (${status.failedCount})`
          }
          variant="secondary"
          size="sm"
          icon="refresh-cw"
          loading={busy}
          disabled={busy}
          onPress={() => void handleStart()}
        />
      </View>
      <Text className="text-2xs text-muted">
        Retries failed receipts one at a time, a few seconds apart, so it won't hit the
        AI provider's rate limit the way a mass re-try would.
      </Text>
      <Pressable onPress={() => setShowModelInput((v) => !v)} hitSlop={6} className="self-start">
        <Text className="text-2xs font-semibold text-muted">
          {showModelInput ? "Hide model override" : "Model override…"}
        </Text>
      </Pressable>
      {showModelInput ? (
        <TextField
          label="Model (advanced)"
          value={modelOverride}
          onChangeText={setModelOverride}
          placeholder="Defaults to the configured model"
        />
      ) : null}
    </View>
  );
}
