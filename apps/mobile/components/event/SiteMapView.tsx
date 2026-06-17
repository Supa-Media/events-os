import { useState } from "react";
import {
  View,
  Image,
  Platform,
  type LayoutChangeEvent,
} from "react-native";
import { colors } from "../../lib/theme";
import {
  type ContainerSize,
  type MarkerGeometry,
  type PlacementGeometry,
  type ShapeGeometry,
} from "../../lib/siteMapGeometry";
import { ShapeView, MarkerView, PlacementView } from "./siteMapShapes";

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
 *
 * All geometry + shape/marker/placement rendering comes from the shared
 * `lib/siteMapGeometry` helpers and `siteMapShapes` primitives.
 */

type Marker = MarkerGeometry & { label: string };
type Shape = ShapeGeometry;
type Placement = PlacementGeometry & { label: string; photoUrl?: string | null };

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
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 });
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
        <PlacementView
          key={`placement-${i}`}
          placement={p}
          // Keep the map uncluttered: names appear on hover, not always.
          labelOnHover
          // Render the supply's actual photo when we have one; otherwise the
          // default glyph (first letter / volunteer initials) is used.
          inner={
            p.kind === "supply" && p.photoUrl ? (
              <Image
                source={{ uri: p.photoUrl }}
                resizeMode="cover"
                style={{ width: "100%", height: "100%", borderRadius: 9999 }}
              />
            ) : undefined
          }
        />
      ))}
    </View>
  );
}
