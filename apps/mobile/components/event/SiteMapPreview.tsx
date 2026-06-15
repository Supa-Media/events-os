import { useState } from "react";
import {
  View,
  Text,
  Image,
  Platform,
  type LayoutChangeEvent,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { optionColor } from "../../lib/optionColor";
import { colors } from "../../lib/theme";

/**
 * SiteMapPreview — a NON-interactive render of an event's site map.
 *
 * Mirrors the rendering math of the editor (`app/(app)/event/[id]/site-map.tsx`):
 * normalized 0..1 coords map to `left:${x*100}%` / `top:${y*100}%`; rect/circle
 * are bordered boxes with a ~12% fill (circle adds `borderRadius:9999`); lines
 * are rotated bars computed from the measured container PIXEL size. Placement
 * circles join `refId` to the supplies/volunteers overlay rows and always show
 * the item's label, so the team can read what goes where.
 *
 * Read-only: NO drag, NO Pressable handlers, NO mutations.
 */

const MAX_MAP_WIDTH = 900;
const DEFAULT_SHAPE_SIZE = 0.18;
const DEFAULT_SHAPE_COLOR = "blue";
const DEFAULT_MARKER_COLOR = "red";
/** Diameter of a placed overlay circle (px). */
const CIRCLE_SIZE = 34;

type Marker = {
  _id: string;
  x: number;
  y: number;
  label?: string | null;
  color?: string | null;
};

type ShapeType = "rect" | "circle" | "line";
type Shape = {
  _id: string;
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
type Placement = {
  _id: string;
  kind: PlacementKind;
  refId: string;
  x: number;
  y: number;
  label: string;
};
type SupplyItem = { refId: string; title: string; photoUrl?: string | null };
type VolunteerItem = { refId: string; name: string };

/** True only when every supplied value is a finite number (guards NaN CSS). */
function allFinite(...ns: (number | null | undefined)[]) {
  return ns.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Resolve a shape color name → its hex value (falls back to the default). */
function shapeHex(color?: string | null) {
  return optionColor(color ?? DEFAULT_SHAPE_COLOR).text;
}

/** Initials — first letters of the first two words, uppercase. */
function initials(name: string | null | undefined) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** First letter of a title, uppercase (empty → ""). */
function firstLetter(title: string | null | undefined) {
  return (title ?? "").trim().charAt(0).toUpperCase();
}

/** A small white reference chip carrying an item/shape label. */
function LabelChip({ text }: { text: string }) {
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

/** One read-only shape (rect / circle / line). */
function PreviewShape({
  shape,
  containerSize,
}: {
  shape: Shape;
  containerSize: { width: number; height: number } | null;
}) {
  const hex = shapeHex(shape.color);
  const fill = `${hex}1F`; // ~12% alpha

  if (shape.type === "line") {
    const W = containerSize?.width ?? 0;
    const H = containerSize?.height ?? 0;
    const nx = shape.x;
    const ny = shape.y;
    const nx2 = shape.x2 ?? shape.x;
    const ny2 = shape.y2 ?? shape.y;
    if (!(W > 0 && H > 0) || !allFinite(nx, ny, nx2, ny2)) return null;
    const dx = (nx2 - nx) * W;
    const dy = (ny2 - ny) * H;
    const length = Math.hypot(dx, dy);
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    return (
      <View
        style={{
          position: "absolute",
          left: `${shape.x * 100}%`,
          top: `${shape.y * 100}%`,
        }}
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
        <View className="absolute" style={{ left: 4, top: 4 }}>
          <LabelChip text={shape.label} />
        </View>
      ) : null}
    </View>
  );
}

/** One read-only marker pin — colored dot + optional label chip. */
function PreviewMarker({ marker }: { marker: Marker }) {
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
        {marker.label ? <LabelChip text={marker.label} /> : null}
      </View>
    </View>
  );
}

/** One read-only placement circle (supply photo/letter, or volunteer initials). */
function PreviewPlacement({
  placement,
  supply,
  volunteer,
}: {
  placement: Placement;
  supply: SupplyItem | null;
  volunteer: VolunteerItem | null;
}) {
  const isSupply = placement.kind === "supply";
  const labelText = isSupply
    ? supply?.title || placement.label || "Supply"
    : volunteer?.name || placement.label || "Volunteer";

  let inner: React.ReactNode;
  if (isSupply && supply?.photoUrl) {
    inner = (
      <Image
        source={{ uri: supply.photoUrl }}
        resizeMode="cover"
        style={{ width: "100%", height: "100%", borderRadius: 9999 }}
      />
    );
  } else if (isSupply) {
    const letter = firstLetter(supply?.title ?? placement.label);
    inner = (
      <View
        className="h-full w-full items-center justify-center"
        style={{ borderRadius: 9999, backgroundColor: colors.infoBg }}
      >
        <Text style={{ fontSize: 15, fontWeight: "700", color: colors.info }}>
          {letter || "?"}
        </Text>
      </View>
    );
  } else {
    const text = initials(volunteer?.name ?? placement.label);
    inner = (
      <View
        className="h-full w-full items-center justify-center"
        style={{ borderRadius: 9999, backgroundColor: colors.successBg }}
      >
        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.success }}>
          {text || "?"}
        </Text>
      </View>
    );
  }

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
          style={{
            width: CIRCLE_SIZE,
            height: CIRCLE_SIZE,
            borderRadius: 9999,
            overflow: "hidden",
            borderWidth: 2,
            borderColor: colors.raised,
            backgroundColor: colors.raised,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
          }}
        >
          {inner}
        </View>
        {/* Reference view always shows the label so the team can read it. */}
        <LabelChip text={labelText} />
      </View>
    </View>
  );
}

export function SiteMapPreview({ eventId }: { eventId: string }) {
  const data = useQuery(api.siteMap.get, {
    scope: { kind: "event", eventId: eventId as any },
  });
  const overlays = useQuery(api.siteMap.overlays, { eventId: eventId as any });

  // Measured container size, used for line geometry.
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  // Natural aspect of the background image (once loaded).
  const [aspect, setAspect] = useState<number | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  const imageUrl = data?.imageUrl ?? null;
  const markers = (data?.markers ?? []) as Marker[];
  const shapes = (data?.shapes ?? []) as Shape[];
  const placements = (overlays?.placements ?? []) as Placement[];
  const supplies = (overlays?.supplies ?? []) as SupplyItem[];
  const volunteers = (overlays?.volunteers ?? []) as VolunteerItem[];

  // Empty: nothing to draw at all → a muted reference card (no canvas).
  const isEmpty =
    !imageUrl &&
    shapes.length === 0 &&
    markers.length === 0 &&
    placements.length === 0;

  if (isEmpty) {
    return (
      <View
        className="w-full self-center items-center justify-center rounded-lg border border-border bg-sunken px-6 py-10"
        style={{ maxWidth: MAX_MAP_WIDTH }}
      >
        <Text className="text-center text-sm text-muted">
          No site map yet — build it from the event's Site map.
        </Text>
      </View>
    );
  }

  return (
    <View className="w-full self-center" style={{ maxWidth: MAX_MAP_WIDTH }}>
      <View
        onLayout={onLayout}
        className="w-full overflow-hidden rounded-lg border border-border bg-sunken"
        style={{ aspectRatio: imageUrl ? aspect ?? 16 / 9 : 16 / 10 }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            resizeMode="contain"
            className="h-full w-full"
            onLoad={(e) => {
              const src = e.nativeEvent.source;
              if (src?.width && src?.height) {
                setAspect(src.width / src.height);
              }
            }}
          />
        ) : (
          // Blank canvas: cream surface + subtle dotted grid.
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

        {/* Shapes (beneath markers + placements). */}
        {shapes.map((s) => (
          <PreviewShape key={s._id} shape={s} containerSize={size} />
        ))}

        {/* Markers. */}
        {markers.map((m) => (
          <PreviewMarker key={m._id} marker={m} />
        ))}

        {/* Placement circles — joined to their supply/volunteer row. */}
        {placements.map((p) => (
          <PreviewPlacement
            key={p._id}
            placement={p}
            supply={
              p.kind === "supply"
                ? supplies.find((s) => s.refId === p.refId) ?? null
                : null
            }
            volunteer={
              p.kind === "volunteer"
                ? volunteers.find((v) => v.refId === p.refId) ?? null
                : null
            }
          />
        ))}
      </View>
    </View>
  );
}
