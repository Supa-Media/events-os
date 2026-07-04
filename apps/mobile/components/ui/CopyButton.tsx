import { useState } from "react";
import { Pressable, Text } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";
import { copyToClipboard } from "../../lib/clipboard";

/**
 * Copies `text` to the clipboard and briefly confirms with a check. Used wherever
 * a doc's text is worth grabbing to paste elsewhere — a table's text cells, the
 * day-panel copy box, the field-chip text editor. Shows the "Copy"/"Copied"
 * label only when `label` is set; otherwise it's an icon-only affordance for
 * tight spots like a grid cell corner.
 */
export function CopyButton({
  text,
  label = false,
}: {
  text: string;
  label?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handlePress = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const tint = copied ? colors.success : colors.muted;
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : "Copy"}
      className="flex-row items-center gap-1 rounded-pill border border-border bg-raised px-1.5 py-0.5 active:opacity-80 web:hover:border-faint"
    >
      <Icon name={copied ? "check" : "copy"} size={11} color={tint} />
      {label ? (
        <Text className="text-2xs font-semibold" style={{ color: tint }}>
          {copied ? "Copied" : "Copy"}
        </Text>
      ) : null}
    </Pressable>
  );
}
