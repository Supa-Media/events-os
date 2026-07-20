/**
 * Merge-tag hint row — lists every tag `MERGE_TAGS` (from `@events-os/shared`)
 * supports, each tap-to-copy so an author can paste `{{firstName}}` etc. into
 * a heading/text/button field without memorizing the syntax.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MERGE_TAGS } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { copyToClipboard } from "../../../lib/clipboard";

export function MergeTagRow() {
  return (
    <View>
      <Text className="mb-1.5 text-xs font-bold uppercase tracking-wider text-faint">
        Merge tags
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        {MERGE_TAGS.map((tag) => (
          <MergeTagChip key={tag.tag} tag={tag.tag} label={tag.label} example={tag.example} />
        ))}
      </View>
    </View>
  );
}

function MergeTagChip({
  tag,
  label,
  example,
}: {
  tag: string;
  label: string;
  example: string;
}) {
  const [copied, setCopied] = useState(false);
  const value = `{{${tag}}}`;

  async function handlePress() {
    if (await copyToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityLabel={`Copy ${label} merge tag`}
      className="flex-row items-center gap-1.5 rounded-pill border border-border bg-raised px-2.5 py-1 active:opacity-80 web:hover:border-faint"
    >
      <Icon name={copied ? "check" : "copy"} size={11} color={copied ? colors.success : colors.muted} />
      <Text className="text-xs font-semibold text-ink">{value}</Text>
      <Text className="text-2xs text-faint">e.g. {example}</Text>
    </Pressable>
  );
}
