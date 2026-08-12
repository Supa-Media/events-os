import { ReactNode, useState } from "react";
import { View, Text, Pressable } from "react-native";

/**
 * Dense-but-breathable data table primitives. A `Table` is a bordered raised
 * surface; `TableHeader` is a sticky-looking label row; `Row` is hoverable and
 * optionally pressable; `Cell` lays out a flexed column. Widths are expressed as
 * flex via the `flex` prop or a fixed `width`.
 */

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <View className={`overflow-hidden rounded-lg border border-border bg-raised shadow-card ${className}`}>
      {children}
    </View>
  );
}

export function TableHeader({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row items-center gap-3 border-b border-border bg-sunken px-4 py-2.5">
      {children}
    </View>
  );
}

export function HeaderCell({
  children,
  flex = 1,
  width,
  align = "left",
}: {
  children: ReactNode;
  flex?: number;
  width?: number;
  align?: "left" | "right" | "center";
}) {
  return (
    <View style={width ? { width } : { flex, minWidth: 0 }} className={alignClass(align)}>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {children}
      </Text>
    </View>
  );
}

export function Row({
  children,
  onPress,
  last = false,
  selected = false,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** Drop the bottom hairline on the final row. */
  last?: boolean;
  /** A side panel is open on this exact row — an accent-tinted background so
   *  which row the panel is showing stays unambiguous while the list keeps
   *  scrolling past it (mirrors `explain.tsx`'s `ExplainRow` accent border,
   *  which is a `Card` rather than a `Row` and so can't share this prop).
   *  Defaults `false`; every existing caller is unaffected. */
  selected?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const border = last ? "" : "border-b border-border";
  const selectedClass = selected ? "bg-accent/10" : "";

  if (!onPress) {
    return (
      <View className={`flex-row items-center gap-3 px-4 py-3 ${border} ${selectedClass}`}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center gap-3 px-4 py-3 ${border} ${
        selected ? "bg-accent/10" : hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      {children}
    </Pressable>
  );
}

export function Cell({
  children,
  flex = 1,
  width,
  align = "left",
}: {
  children: ReactNode;
  flex?: number;
  width?: number;
  align?: "left" | "right" | "center";
}) {
  return (
    <View style={width ? { width } : { flex, minWidth: 0 }} className={alignClass(align)}>
      {children}
    </View>
  );
}

function alignClass(align: "left" | "right" | "center"): string {
  if (align === "right") return "items-end";
  if (align === "center") return "items-center";
  return "items-start";
}
