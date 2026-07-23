import { useState } from "react";
import { Pressable, View, Text } from "react-native";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import { colors } from "../../lib/theme";

type Props = {
  text: string;
  /** Size of the info icon (default 14). */
  size?: number;
  /** Color of the info icon (default inherited ink). */
  color?: string;
};

/**
 * A small info icon that opens a tooltip popover on press. The popover is
 * anchored near the icon and dismisses on backdrop press.
 */
export function InfoTooltip({ text, size = 14, color = colors.info }: Props) {
  const [visible, setVisible] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | undefined>();

  return (
    <>
      <Pressable
        onPress={(e) => {
          const { pageX, pageY } = e.nativeEvent;
          setAnchor({ x: pageX - 7, y: pageY - 7, width: 14, height: 14 });
          setVisible(true);
        }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Icon name="info" size={size} color={color} />
      </Pressable>
      <Popover visible={visible} onClose={() => setVisible(false)} anchor={anchor} width={240}>
        <Text className="p-3 text-2xs leading-relaxed text-ink">{text}</Text>
      </Popover>
    </>
  );
}
