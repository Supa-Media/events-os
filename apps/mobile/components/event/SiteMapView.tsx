import { useState } from "react";
import {
  View,
  Text,
  Image,
  Platform,
  type LayoutChangeEvent,
} from "react-native";
import { Icon } from "../ui";
import { optionColor } from "../../lib/optionColor";
import { colors } from "../../lib/theme";

/**
 * READ-ONLY site map renderer for the PUBLIC share page.
 *
 * Takes the shape of `api.siteMap.publicSiteMap` and draws the venue: a
 * fixed-aspect (16:9) container at full width, the optional background image,
 * the sketched shapes (rect / circle / line) and labelled markers, plus the
 * supply/volunteer placement chips — each positioned from its normalized
 * (x, y) coordinate against the measured container size. No gestures, no
 * editing; the coordinate math mirrors `SiteMapEditor` so the public view lines
 * up with what the organizer drew. Dependency-light: just absolutely-positioned
 * Views, so it renders fine on web.
 */

type Marker = { x: number; y: number; label: string; color?: string | null };
type ShapeType = "rect" | "circle" | "line";
type Shape = {
  type: ShapeType;
  x: number;
  y: number;
  w?: number | null;
  h?: number | null;
  x2?: number | null;
  y2?: number | null;
  color?: string | null;
  label?: string | null;
};
type PlacementKind = "supply" | "volunteer";
type Placement = { x: number; y: number; label: string; kind: PlacementKind };

const DEFAULT_SHAPE_SIZE = 0.18;
const DEFAULT_SHAPE_COLOR = "blue";
const DEFAULT_MARKER_COLOR = "red";
const CIRCLE_SIZE = 36;

/** True only when every value is a finite number (guards NaN CSS). */
function allFinite(...ns: (number | null | undefined)[]) {
  return ns.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Resolve a shape color name → its hex value (falls back to the default). */
function shapeHex(color?: string | null) {
  return optionColor(color ?? DEFAULT_SHAPE_COLOR).text;
}

/** Initials from a name — first letters of the first two words, uppercase. */
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** First letter of a title, uppercase. */
function firstLetter(title: string) {
  return title.trim().charAt(0).toUpperCase();
}

const PLACEMENT_STYLE: Record<
  PlacementKind,
  { icon: "package" | "users"; bg: string; fg: string }
> = {
  supply: { icon: "package", bg: colors.infoBg, fg: colors.info },
  volunteer: { icon: "users", bg: colors.successBg, fg: colors.success },
};

// ── A single read-only shape (rect / circle / line) ──────────────────────────
function ShapeView({
  shape,
  size,
}: {
  shape: Shape;
  size: { width: number; height: number };
}) {
  const hex = shapeHex(shape.color);
  const fill = `${hex}1F`; // ~12% alpha

  if (shape.type === "line") {
    const { width: W, height: H } = size;
    const nx = shape.x;
    const ny = shape.y;
    const nx2 = shape.x2 ?? shape.x;
    const ny2 = shape.y2 ?? shape.y;
    if (!(W > 0 && H > 0) || !allFinite(nx, ny, nx2, ny2)) return null;
    const x1 = nx * W;
    const y1 = ny * H;
    const x2 = nx2 * W;
    const y2 = ny2 * H;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angleDeg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;

    return (
      <View
        style={{ position: "absolute", left: `${shape.x * 100}%`, top: `${shape.y * 100}%` }}
      >
        <View
          style={{
            width: length,
            height: 3,
            backgroundColor: hex,
            borderRadius: 2,
            transform: [{ rotateZ: `${angleDeg}deg` }],
            ...(Platform.OS === "web"
              ? ({ transformOrigin: "left center" } as any)
              : null),
          }}
        />
        {shape.label ? (
          <View
            className="rounded-sm px-1.5 py-0.5"
            style={{ backgroundColor: "rgba(255,255,255,0.92)", marginTop: 2 }}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: colors.ink }}
              numberOfLines={1}
            >
              {shape.label}
            </Text>
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
        left: `${shape.x * 100}%`,
        top: `${shape.y * 100}%`,
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
          backgroundColor: fill,
          borderRadius: shape.type === "circle" ? 9999 : 8,
        }}
      />
      {shape.label ? (
        <View
          className="absolute rounded-sm px-1.5 py-0.5"
          style={{ backgroundColor: "rgba(255,255,255,0.92)", left: 4, top: 4 }}
        >
          <Text
            className="text-xs font-semibold"
            style={{ color: colors.ink }}
            numberOfLines={1}
          >
            {shape.label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ── A single read-only marker pin ────────────────────────────────────────────
function MarkerView({ marker }: { marker: Marker }) {
  const color = optionColor(marker.color ?? DEFAULT_MARKER_COLOR).text;
  return (
    <View
      style={{
        position: "absolute",
        left: `${marker.x * 100}%`,
        top: `${marker.y * 100}%`,
        transform: [{ translateX: -8 }, { translateY: -8 }],
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
        {marker.label ? (
          <View
            className="self-start rounded-sm px-1.5 py-0.5"
            style={{ backgroundColor: "rgba(255,255,255,0.92)" }}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: colors.ink }}
              numberOfLines={1}
            >
              {marker.label}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── A single read-only placement chip (supply / volunteer) ───────────────────
// A small circle centered on its point with a label chip to the right, so the
// reader can see "where everyone / everything is placed".
function PlacementView({ placement }: { placement: Placement }) {
  const style = PLACEMENT_STYLE[placement.kind];
  const glyph =
    placement.kind === "supply"
      ? firstLetter(placement.label)
      : initials(placement.label);

  return (
    <View
      style={{
        position: "absolute",
        left: `${placement.x * 100}%`,
        top: `${placement.y * 100}%`,
        transform: [
          { translateX: -CIRCLE_SIZE / 2 },
          { translateY: -CIRCLE_SIZE / 2 },
        ],
      }}
    >
      <View className="flex-row items-center gap-1.5">
        <View
          className="items-center justify-center rounded-pill border-2 border-white"
          style={{
            width: CIRCLE_SIZE,
            height: CIRCLE_SIZE,
            backgroundColor: style.bg,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 3,
            shadowOffset: { width: 0, height: 1 },
          }}
        >
          {glyph ? (
            <Text
              className="text-sm font-bold"
              style={{ color: style.fg }}
            >
              {glyph}
            </Text>
          ) : (
            <Icon name={style.icon} size={16} color={style.fg} />
          )}
        </View>
        {placement.label ? (
          <View
            className="self-start rounded-sm px-1.5 py-0.5"
            style={{ backgroundColor: "rgba(255,255,255,0.92)" }}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: colors.ink }}
              numberOfLines={1}
            >
              {placement.label}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function SiteMapView({
  imageUrl,
  markers,
  shapes,
  placements,
}: {
  imageUrl: string | null;
  markers: Marker[];
  shapes: Shape[];
  placements: Placement[];
}) {
  // Measured container size — lines need pixel geometry; everything else uses
  // percentage positioning, so it renders even before the first measurement.
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  return (
    <View
      onLayout={onLayout}
      className="w-full overflow-hidden rounded-lg border border-border bg-sunken"
      style={{ aspectRatio: 16 / 9 }}
    >
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          resizeMode="contain"
          className="h-full w-full"
        />
      ) : (
        // Blank canvas: cream surface + a subtle dotted grid (web).
        <View
          className="h-full w-full"
          style={{
            backgroundColor: colors.surface,
            ...(Platform.OS === "web"
              ? ({
                  backgroundImage: `radial-gradient(${colors.borderStrong} 1px, transparent 1px)`,
                  backgroundSize: "20px 20px",
                } as any)
              : null),
          }}
        />
      )}

      {/* Shapes BENEATH markers & placements. */}
      {shapes.map((s, i) => (
        <ShapeView key={`shape-${i}`} shape={s} size={size} />
      ))}
      {markers.map((m, i) => (
        <MarkerView key={`marker-${i}`} marker={m} />
      ))}
      {placements.map((p, i) => (
        <PlacementView key={`placement-${i}`} placement={p} />
      ))}
    </View>
  );
}
