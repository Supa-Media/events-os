/**
 * Site-map render primitives — the READ-ONLY presentational pieces shared by the
 * site map surfaces (editor canvas, inline preview, public view). They were
 * duplicated across `SiteMapEditor.tsx`, `SiteMapPreview.tsx`, and
 * `SiteMapView.tsx`; this is the single, dumb (props-in / JSX-out) version.
 *
 * No data fetching, no mutations, no gestures — just absolutely-positioned Views
 * driven by the normalized geometry helpers in `lib/siteMapGeometry`. Lines need
 * the measured container PIXEL size; everything else uses percentage positioning
 * so it renders even before the first layout. Web-safe (no function-style
 * Pressable styles; `transformOrigin` is gated behind `Platform.OS === "web"`).
 */
import type { ReactNode } from "react";
import { View, Text, Platform } from "react-native";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import {
  CIRCLE_SIZE,
  DEFAULT_SHAPE_SIZE,
  MARKER_HALF,
  lineGeometry,
  markerHex,
  percentPosition,
  shapeFill,
  shapeHex,
  type ContainerSize,
  type MarkerGeometry,
  type PlacementGeometry,
  type PlacementKind,
  type ShapeGeometry,
} from "../../lib/siteMapGeometry";

/** A small white reference chip carrying an item/shape/marker label. */
export function LabelChip({ text }: { text: string }) {
  return (
    <View
      className="rounded-sm px-1.5 py-0.5"
      style={{ backgroundColor: "rgba(255,255,255,0.92)" }}
    >
      <Text
        className="text-xs font-semibold"
        style={{ color: colors.ink }}
        numberOfLines={1}
      >
        {text}
      </Text>
    </View>
  );
}

/** Per-kind placement styling — icon + readable theme background/foreground. */
const PLACEMENT_STYLE: Record<
  PlacementKind,
  { icon: "package" | "users"; bg: string; fg: string }
> = {
  supply: { icon: "package", bg: colors.infoBg, fg: colors.info },
  volunteer: { icon: "users", bg: colors.successBg, fg: colors.success },
};

/**
 * A single read-only shape (rect / circle / line). Lines compute pixel geometry
 * from the measured `size` and don't render until it's known.
 */
export function ShapeView({
  shape,
  size,
}: {
  shape: ShapeGeometry;
  size: ContainerSize;
}) {
  const hex = shapeHex(shape.color);

  if (shape.type === "line") {
    const geo = lineGeometry(shape, size);
    if (!geo) return null;
    return (
      <View style={{ position: "absolute", ...percentPosition(shape.x, shape.y) }}>
        <View
          style={{
            width: geo.length,
            height: 3,
            backgroundColor: hex,
            borderRadius: 2,
            transform: [{ rotateZ: `${geo.angleDeg}deg` }],
            ...(Platform.OS === "web"
              ? ({ transformOrigin: "left center" } as any)
              : null),
          }}
        />
        {shape.label ? (
          <View style={{ marginTop: 2 }}>
            <LabelChip text={shape.label} />
          </View>
        ) : null}
      </View>
    );
  }

  // rect + circle: an absolutely-positioned box (circle = full border radius).
  const w = shape.w ?? DEFAULT_SHAPE_SIZE;
  const h = shape.h ?? DEFAULT_SHAPE_SIZE;
  return (
    <View
      style={{
        position: "absolute",
        ...percentPosition(shape.x, shape.y),
        width: `${w * 100}%`,
        height: `${h * 100}%`,
      }}
    >
      <View
        style={{
          width: "100%",
          height: "100%",
          borderWidth: 2,
          borderColor: hex,
          backgroundColor: shapeFill(shape.color),
          borderRadius: shape.type === "circle" ? 9999 : 8,
        }}
      />
      {shape.label ? (
        <View className="absolute" style={{ left: 4, top: 4 }}>
          <LabelChip text={shape.label} />
        </View>
      ) : null}
    </View>
  );
}

/** A single read-only marker pin — a colored dot + optional label chip. */
export function MarkerView({ marker }: { marker: MarkerGeometry }) {
  const color = markerHex(marker.color);
  return (
    <View
      style={{
        position: "absolute",
        ...percentPosition(marker.x, marker.y),
        transform: [{ translateX: -MARKER_HALF }, { translateY: -MARKER_HALF }],
      }}
    >
      <View className="flex-row items-center gap-1.5">
        <View
          className="h-4 w-4 rounded-pill border-2 border-white"
          style={{
            backgroundColor: color,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 2,
            shadowOffset: { width: 0, height: 1 },
          }}
        />
        {marker.label ? <LabelChip text={marker.label} /> : null}
      </View>
    </View>
  );
}

/**
 * A single read-only placement chip (supply / volunteer): a circle centered on
 * its point with a label chip to the right. By default the circle shows a glyph
 * (supply → first letter; volunteer → initials) over the kind's tinted theme;
 * pass `inner` to render custom content (e.g. a supply photo) and the circle
 * becomes a neutral clipped ring instead. `size` defaults to the canonical
 * {@link CIRCLE_SIZE} but the editor may scale it up for a comfortable target.
 */
export function PlacementView({
  placement,
  inner,
  size = CIRCLE_SIZE,
}: {
  placement: PlacementGeometry;
  /** Custom circle content (e.g. a supply photo). Omit for the default glyph. */
  inner?: ReactNode;
  size?: number;
}) {
  const style = PLACEMENT_STYLE[placement.kind];
  const label = placement.label ?? "";

  const circleStyle = inner
    ? {
        overflow: "hidden" as const,
        borderColor: colors.raised,
        backgroundColor: colors.raised,
      }
    : { borderColor: "#fff", backgroundColor: style.bg };

  return (
    <View
      style={{
        position: "absolute",
        ...percentPosition(placement.x, placement.y),
        transform: [{ translateX: -size / 2 }, { translateY: -size / 2 }],
      }}
    >
      <View className="flex-row items-center gap-1.5">
        <View
          className="items-center justify-center rounded-pill border-2"
          style={{
            width: size,
            height: size,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 3,
            shadowOffset: { width: 0, height: 1 },
            ...circleStyle,
          }}
        >
          {inner ?? <PlacementGlyph placement={placement} style={style} />}
        </View>
        {label ? <LabelChip text={label} /> : null}
      </View>
    </View>
  );
}

/** Default circle content: a glyph (supply letter / volunteer initials) or icon. */
function PlacementGlyph({
  placement,
  style,
}: {
  placement: PlacementGeometry;
  style: { icon: "package" | "users"; fg: string };
}) {
  // The label already carries the resolved name/title from the data layer.
  const text = (placement.label ?? "").trim();
  const glyph =
    placement.kind === "supply"
      ? text.charAt(0).toUpperCase()
      : text
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w.charAt(0).toUpperCase())
          .join("");

  if (glyph) {
    return (
      <Text className="text-sm font-bold" style={{ color: style.fg }}>
        {glyph}
      </Text>
    );
  }
  return <Icon name={style.icon} size={16} color={style.fg} />;
}
