import { Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@events-os/convex/_generated/api";
import { Button, Card, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

type EditorState = FunctionReturnType<typeof api.academyEditor.courseEditor>;

/**
 * The editor's side column: what this draft changes, what still blocks
 * publishing, and every earlier published version (any of which can be
 * brought back as a new draft).
 */
export function DraftPanel({
  state,
  changes,
  problems,
  onRestore,
}: {
  state: EditorState;
  changes: string[];
  problems: string[];
  onRestore: (version: number, label: string) => void;
}) {
  const draft = state.draft;
  // Publishing "back to built-in" records a version but leaves no edit live.
  const builtInLive = state.published === null;
  return (
    <View className="gap-4">
      <Card padding="md">
        <Text className="mb-1 text-base font-semibold text-ink">In this draft</Text>
        {draft ? (
          <Text className="mb-2 text-xs text-muted">
            {`Last saved by ${draft.updatedByMe ? "you" : draft.updatedByName}. Anyone with the power can pick it up.`}
          </Text>
        ) : null}
        {changes.length === 0 ? (
          <Text className="text-sm text-muted">
            Nothing yet. Learners see the published course until you publish.
          </Text>
        ) : (
          <View className="gap-1.5">
            {changes.map((line, i) => (
              <View key={i} className="flex-row gap-2">
                <Text className="text-sm text-muted">•</Text>
                <Text className="flex-1 text-sm text-ink">{line}</Text>
              </View>
            ))}
          </View>
        )}
        {problems.length > 0 ? (
          <View className="mt-3 gap-1.5 rounded-md border border-danger bg-danger-bg p-3">
            <View className="flex-row items-center gap-1.5">
              <Icon name="alert-triangle" size={14} color={colors.danger} />
              <Text className="text-sm font-semibold text-ink">Fix before publishing</Text>
            </View>
            {problems.slice(0, 8).map((p, i) => (
              <Text key={i} className="text-sm text-ink">
                {p}
              </Text>
            ))}
            {problems.length > 8 ? (
              <Text className="text-xs text-muted">{`…and ${problems.length - 8} more`}</Text>
            ) : null}
          </View>
        ) : null}
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-base font-semibold text-ink">History</Text>
        <View className="gap-2.5">
          {state.versions.map((v) => {
            const live = v.version === state.currentVersion;
            const when = new Date(v.publishedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            });
            return (
              <View key={v.version} className="flex-row items-start gap-2">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink">
                    {`Version ${v.version}${v.isBuiltIn ? " · built-in" : ""}${live ? " · live" : ""}`}
                  </Text>
                  <Text className="text-xs text-muted">{`${v.publishedByName}, ${when}`}</Text>
                  {v.summary.slice(0, 3).map((line, i) => (
                    <Text key={i} className="text-xs text-muted" numberOfLines={1}>
                      {line}
                    </Text>
                  ))}
                </View>
                {live ? null : (
                  <Button
                    title="Restore"
                    size="sm"
                    variant="ghost"
                    onPress={() => onRestore(v.version, `version ${v.version}`)}
                  />
                )}
              </View>
            );
          })}
          <View className="flex-row items-start gap-2">
            <View className="flex-1">
              <Text className="text-sm font-semibold text-ink">
                {`Built-in version${builtInLive ? " · live" : ""}`}
              </Text>
              <Text className="text-xs text-muted">The course as it ships in the app.</Text>
            </View>
            {builtInLive ? null : (
              <Button
                title="Restore"
                size="sm"
                variant="ghost"
                onPress={() => onRestore(0, "the built-in version")}
              />
            )}
          </View>
        </View>
      </Card>

      <View className="flex-row gap-2 px-1">
        <Icon name="key" size={14} color={colors.faint} />
        <Text className="flex-1 text-xs text-muted">
          You can edit because your seat holds the "Edit Academy courses" power. Whoever
          runs the org chart can give it to other seats.
        </Text>
      </View>
    </View>
  );
}
