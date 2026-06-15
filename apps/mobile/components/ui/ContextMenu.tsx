import { Pressable, Text } from "react-native";
import { Icon, type IconName } from "./Icon";
import { Popover } from "./Popover";
import { colors } from "../../lib/theme";

export type ContextMenuAction = {
  label: string;
  icon?: IconName;
  onPress: () => void;
  destructive?: boolean;
};

export type ContextMenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * A small anchored menu of actions, rendered in a {@link Popover}. Shared by the
 * role chips and the module rows/chips: right-click (web) or long-press (native)
 * an element to open it. `anchor === undefined` means closed.
 */
export function ContextMenu({
  anchor,
  actions,
  width = 180,
  onClose,
}: {
  anchor?: ContextMenuAnchor;
  actions: ContextMenuAction[];
  width?: number;
  onClose: () => void;
}) {
  return (
    <Popover visible={anchor !== undefined} anchor={anchor} width={width} onClose={onClose}>
      {actions.map((action) => (
        <ContextMenuRow
          key={action.label}
          action={action}
          onClose={onClose}
        />
      ))}
    </Popover>
  );
}

function ContextMenuRow({
  action,
  onClose,
}: {
  action: ContextMenuAction;
  onClose: () => void;
}) {
  const tint = action.destructive ? colors.danger : colors.ink;
  return (
    <Pressable
      onPress={() => {
        onClose();
        action.onPress();
      }}
      className="flex-row items-center gap-2 px-3 py-2.5 active:bg-sunken web:hover:bg-sunken"
    >
      {action.icon ? (
        <Icon
          name={action.icon}
          size={14}
          color={action.destructive ? colors.danger : colors.muted}
        />
      ) : null}
      <Text className="text-sm" style={{ color: tint }}>
        {action.label}
      </Text>
    </Pressable>
  );
}

/**
 * Measure a node into window coords and hand the rect to `cb`. Falls back to a
 * zero rect (centered popover) when measurement isn't available. Shared by all
 * context-menu openers.
 */
export function measureAnchor(
  node: any,
  cb: (anchor: ContextMenuAnchor) => void,
) {
  if (node && typeof node.measureInWindow === "function") {
    node.measureInWindow(
      (x: number, y: number, width: number, height: number) =>
        cb({ x, y, width, height }),
    );
  } else {
    cb({ x: 0, y: 0, width: 0, height: 0 });
  }
}
