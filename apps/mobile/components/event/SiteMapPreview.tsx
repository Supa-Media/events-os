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
import { colors } from "../../lib/theme";
import {
  firstLetter,
  initials,
  type ContainerSize,
  type MarkerGeometry,
  type PlacementGeometry,
  type PlacementKind,
  type ShapeGeometry,
} from "../../lib/siteMapGeometry";
import { ShapeView, MarkerView, PlacementView } from "./siteMapShapes";

/**
 * SiteMapPreview — a NON-interactive render of an event's site map.
 *
 * Normalized 0..1 coords map to `left:${x*100}%` / `top:${y*100}%`; rect/circle
 * are bordered boxes with a ~12% fill (circle adds `borderRadius:9999`); lines
 * are rotated bars computed from the measured container PIXEL size. Placement
 * circles join `refId` to the supplies/volunteers overlay rows and always show
 * the item's label, so the team can read what goes where.
 *
 * All geometry + shape/marker rendering comes from the shared
 * `lib/siteMapGeometry` helpers and `siteMapShapes` primitives; this file keeps
 * only the data joins (supply photo / volunteer name) it needs.
 *
 * Read-only: NO drag, NO Pressable handlers, NO mutations.
 */

const MAX_MAP_WIDTH = 900;

type Marker = MarkerGeometry & { _id: string };
type Shape = ShapeGeometry & { _id: string };

type Placement = PlacementGeometry & {
  _id: string;
  refId: string;
  label: string;
};
type SupplyItem = { refId: string; title: string; photoUrl?: string | null };
type VolunteerItem = { refId: string; name: string };

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

  // Custom inner content: supply photo, or a tinted glyph badge. The reference
  // view resolves the glyph from the joined supply/volunteer row (the shared
  // PlacementGlyph would otherwise read placement.label only).
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

  // Always show the resolved label (not just placement.label) in the reference
  // view, so override the placement's label before handing it to PlacementView.
  return (
    <PlacementView
      placement={{ ...placement, label: labelText }}
      inner={inner}
    />
  );
}

export function SiteMapPreview({ eventId }: { eventId: string }) {
  const data = useQuery(api.siteMap.get, {
    scope: { kind: "event", eventId: eventId as any },
  });
  const overlays = useQuery(api.siteMap.overlays, {
    scope: { kind: "event", eventId: eventId as any },
  });

  // Measured container size, used for line geometry.
  const [size, setSize] = useState<ContainerSize>(null);
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
          <ShapeView key={s._id} shape={s} size={size} />
        ))}

        {/* Markers. */}
        {markers.map((m) => (
          <MarkerView key={m._id} marker={m} />
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
