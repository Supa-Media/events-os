import { Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warn"
  | "danger"
  | "info"
  | "lavender";

type Props = {
  label: string;
  tone?: BadgeTone;
  icon?: IconName;
};

const TONES: Record<BadgeTone, { bg: string; text: string; icon: string }> = {
  neutral: { bg: "bg-sunken", text: "text-muted", icon: colors.muted },
  accent: { bg: "bg-accent-soft", text: "text-accent", icon: colors.accent },
  success: { bg: "bg-success-bg", text: "text-success", icon: colors.success },
  warn: { bg: "bg-warn-bg", text: "text-warn", icon: colors.warn },
  danger: { bg: "bg-danger-bg", text: "text-danger", icon: colors.danger },
  info: { bg: "bg-info-bg", text: "text-info", icon: colors.info },
  lavender: { bg: "bg-lavender/40", text: "text-stat-purple", icon: colors.statPurple },
};

/** A small status chip. Pastel-tinted background + matching label. */
export function Badge({ label, tone = "neutral", icon }: Props) {
  const t = TONES[tone];
  return (
    <View
      className={`flex-row items-center self-start gap-1 rounded-sm px-2 py-0.5 ${t.bg}`}
    >
      {icon ? <Icon name={icon} size={11} color={t.icon} /> : null}
      <Text className={`text-xs font-semibold ${t.text}`}>{label}</Text>
    </View>
  );
}
