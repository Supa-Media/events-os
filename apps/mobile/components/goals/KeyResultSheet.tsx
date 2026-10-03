/**
 * One key result, opened from the Goals screen: how it's going, posting an
 * update, the projects that move it, its history, and (for plan editors)
 * every field of it. The key result is the score; the work lives in the
 * linked projects, events and duties, never here.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  KEY_RESULT_MEASURE_LABELS,
  KEY_RESULT_STATUSES,
  KEY_RESULT_STATUS_LABELS,
  formatGoalValue,
  type KeyResultStatus,
} from "@events-os/shared";
import { Badge, BottomSheet, Button, Pill, ProgressBar, SheetRow, TextField } from "../ui";
import { EditableText } from "./EditableText";
import { KeyResultEditor, type EditorOptions } from "./KeyResultEditor";
import type { KeyResultRow, Objective } from "./ObjectiveList";
import { formatDue, keyResultTone, parseNumber } from "./goalsFormat";
import { formatDateTime } from "../../lib/format";
import { alertError } from "../../lib/errors";

function SectionLabel({ children }: { children: string }) {
  return <Text className="text-xs font-semibold uppercase tracking-wide text-muted">{children}</Text>;
}

export function KeyResultSheet({
  kr,
  objectives,
  canEdit,
  canUpdate,
  options,
  onClose,
}: {
  kr: KeyResultRow | null;
  objectives: Objective[];
  canEdit: boolean;
  canUpdate: boolean;
  options: EditorOptions | undefined;
  onClose: () => void;
}) {
  return (
    <BottomSheet visible={kr != null} onClose={onClose} title={kr ? `Key result ${kr.code}` : undefined}>
      {kr ? (
        <SheetBody
          key={kr._id}
          kr={kr}
          objectives={objectives}
          canEdit={canEdit}
          canUpdate={canUpdate}
          options={options}
          onClose={onClose}
        />
      ) : null}
    </BottomSheet>
  );
}

function SheetBody({
  kr,
  objectives,
  canEdit,
  canUpdate,
  options,
  onClose,
}: {
  kr: KeyResultRow;
  objectives: Objective[];
  canEdit: boolean;
  canUpdate: boolean;
  options: EditorOptions | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const detail = useQuery(api.goals.keyResult, { keyResultId: kr._id });
  const updateKeyResult = useMutation(api.goalsEdit.updateKeyResult);
  const postUpdate = useMutation(api.goalsEdit.postUpdate);
  const [status, setStatus] = useState<KeyResultStatus>(kr.status);
  const [current, setCurrent] = useState(kr.current != null ? String(kr.current) : "");
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState(false);
  const p = kr.progress;
  const manual = kr.measureKind === "manual";

  const post = async () => {
    const n = parseNumber(current);
    if (n === undefined) return alertError(new Error("Progress needs to be a number."));
    setPosting(true);
    try {
      await postUpdate({
        keyResultId: kr._id,
        status,
        current: manual && n != null ? n : undefined,
        note: note.trim() || undefined,
      });
      setNote("");
    } catch (err) {
      alertError(err);
    } finally {
      setPosting(false);
    }
  };

  return (
    <View className="gap-5 pb-4">
      <View className="gap-2">
        <EditableText
          label="key result"
          value={kr.title}
          canEdit={canEdit}
          multiline
          textClassName="text-base font-semibold text-ink leading-6"
          onSave={(title) => updateKeyResult({ keyResultId: kr._id, title })}
        />
        <View className="flex-row flex-wrap items-center gap-2">
          <Badge label={KEY_RESULT_STATUS_LABELS[p.displayStatus]} tone={keyResultTone(p.displayStatus)} />
          {kr.ownerLabel ? <Badge label={kr.ownerLabel} tone="lavender" /> : <Badge label="No owner yet" />}
          {kr.dueDate ? <Text className="text-xs text-muted">Due {formatDue(kr.dueDate)}</Text> : null}
          {kr.timing ? <Text className="text-xs text-muted">{kr.timing}</Text> : null}
        </View>
        {kr.contributorNames.length > 0 ? (
          <Text className="text-xs text-muted">With {kr.contributorNames.join(", ")}</Text>
        ) : null}
        <Text className="text-xs text-muted">Measured by: {KEY_RESULT_MEASURE_LABELS[kr.measureKind]}</Text>
        {p.fraction != null ? (
          <View className="gap-1">
            <ProgressBar fraction={p.fraction} />
            <Text className="text-xs text-muted">
              {formatGoalValue(p.current ?? 0, kr.unit)} of {formatGoalValue(p.target ?? 0, kr.unit)}
              {manual
                ? ""
                : kr.measureKind === "seat_filled"
                  ? `, counting people seated since ${formatDue(kr.seatWatchSince ?? kr._creationTime)}`
                  : ", counted automatically"}
            </Text>
          </View>
        ) : null}
      </View>

      {canUpdate ? (
        <View className="gap-2">
          <SectionLabel>Post an update</SectionLabel>
          <View className="flex-row flex-wrap gap-2">
            {KEY_RESULT_STATUSES.map((s) => (
              <Pill key={s} size="sm" label={KEY_RESULT_STATUS_LABELS[s]} selected={status === s} onPress={() => setStatus(s)} />
            ))}
          </View>
          {manual ? (
            <TextField label="Where it stands" value={current} onChangeText={setCurrent} keyboardType="numeric" placeholder={kr.target != null ? `out of ${kr.target}` : "A number"} />
          ) : null}
          <TextField label="Note" value={note} onChangeText={setNote} multiline numberOfLines={2} placeholder="What changed, what's in the way" />
          <View className="items-start">
            <Button title="Post update" size="sm" onPress={post} loading={posting} />
          </View>
        </View>
      ) : null}

      <View className="gap-2">
        <SectionLabel>Work that moves it</SectionLabel>
        {detail === undefined ? null : detail === null || (detail.projects.length === 0 && detail.otherChapterProjectCount === 0) ? (
          <Text className="text-sm text-muted">
            Nothing linked yet. Open a project and pick this key result under Goal.
          </Text>
        ) : (
          <View>
            {detail.projects.map((pr, i) => (
              <SheetRow
                key={pr._id}
                first={i === 0}
                icon="git-branch"
                label={pr.name}
                onPress={() => {
                  onClose();
                  router.push(`/project/${pr._id}` as any);
                }}
              />
            ))}
            {detail.otherChapterProjectCount > 0 ? (
              <Text className="text-xs text-muted pt-2">
                Plus {detail.otherChapterProjectCount} in other chapters.
              </Text>
            ) : null}
          </View>
        )}
      </View>

      {detail && detail.updates.length > 0 ? (
        <View className="gap-2">
          <SectionLabel>Updates</SectionLabel>
          {detail.updates.map((u) => (
            <View key={u._id} className="gap-0.5 border-l-2 border-border pl-3">
              <View className="flex-row items-center gap-2">
                <Badge label={KEY_RESULT_STATUS_LABELS[u.status]} tone={keyResultTone(u.status)} />
                <Text className="text-xs text-muted">
                  {u.authorName ?? "Someone"} · {formatDateTime(u.createdAt)}
                </Text>
              </View>
              {u.current != null ? (
                <Text className="text-xs text-muted">At {formatGoalValue(u.current, kr.unit)}</Text>
              ) : null}
              {u.note ? <Text className="text-sm text-ink">{u.note}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {canEdit && options ? (
        <View className="gap-2">
          {editing ? (
            <>
              <SectionLabel>Edit details</SectionLabel>
              <KeyResultEditor kr={kr} objectives={objectives} options={options} onDeleted={onClose} />
            </>
          ) : (
            <View className="items-start">
              <Button title="Edit owner, dates and measure" variant="secondary" icon="edit-2" onPress={() => setEditing(true)} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}
