import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  ActivityIndicator,
  Platform,
  Modal,
  Linking,
  ScrollView,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Rnd } from "react-rnd";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  PageHeader,
  Button,
  Icon,
  TextField,
} from "../ui";
import { optionColor } from "../../lib/optionColor";
import { colors } from "../../lib/theme";
import {
  CIRCLE_SIZE as BASE_CIRCLE_SIZE,
  DEFAULT_MARKER_COLOR,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_SIZE,
  MARKER_HALF,
  clamp01,
  firstLetter,
  initials,
  lineGeometry,
  markerHex,
  percentPosition,
  shapeFill,
  shapeHex,
  type MarkerGeometry,
  type ShapeGeometry,
} from "../../lib/siteMapGeometry";

/** A site-map marker as returned by `api.siteMap.get`. */
type Marker = MarkerGeometry & { _id: string };

/** A site-map shape as returned by `api.siteMap.get` (all coords normalized 0..1). */
type Shape = ShapeGeometry & { _id: string };

/** Draw-mode for the canvas toolbar. */
type DrawMode = "select" | "pin" | "rect" | "circle" | "line";

/** A single reversible operation on the undo/redo stack. */
type Op = { undo: () => void | Promise<void>; redo: () => void | Promise<void> };

/** Overlay layer kinds — supplies & volunteers, an independent visual layer. */
type PlacementKind = "supply" | "volunteer";
/** A placed overlay chip as returned by `api.siteMap.overlays`. */
type Placement = {
  _id: string;
  kind: PlacementKind;
  refId: string;
  x: number;
  y: number;
  label: string;
};
/** An unplaced overlay item (a supply or a volunteer) drawn in the tray. */
type TrayItem = { refId: string; label: string };

/** Enriched supply row from `api.siteMap.overlays`. */
type SupplyItem = {
  refId: string;
  title: string;
  photoUrl?: string | null;
  status?: string | null;
  packedIn?: string | null;
  source?: string | null;
  link?: string | null;
  qty?: number | null;
  cost?: number | null;
  notes?: string | null;
};
/** Enriched volunteer row from `api.siteMap.overlays`. */
type VolunteerItem = {
  refId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  team?: string | null;
  status?: string | null;
  service?: string | null;
};
/** A placed circle joined to its enriched supply/volunteer item. */
type PlacementDetail =
  | { placement: Placement; kind: "supply"; item: SupplyItem | null }
  | { placement: Placement; kind: "volunteer"; item: VolunteerItem | null };

const MAX_MAP_WIDTH = 900;

/** Palette offered in the toolbar — reuses the OptionTag color names. */
const SHAPE_COLORS = ["red", "blue", "green", "amber", "purple", "gray"] as const;

/**
 * Placed-circle diameter in the EDITOR — the canonical {@link BASE_CIRCLE_SIZE}
 * scaled up to a comfortable drag/tap target. The read-only renderers use the
 * shared base; only the interactive editor needs the larger hit area.
 */
const CIRCLE_SIZE = BASE_CIRCLE_SIZE + 6; // 42

/** Marker pin half-offset for react-rnd positioning (px). */
const MARKER_RND_OFFSET = MARKER_HALF + 1; // 9

/** Per-kind overlay styling — icon + readable theme background/foreground. */
const OVERLAY_STYLE: Record<
  PlacementKind,
  { icon: "package" | "users"; bg: string; fg: string; label: string }
> = {
  supply: { icon: "package", bg: colors.infoBg, fg: colors.info, label: "Supplies" },
  volunteer: {
    icon: "users",
    bg: colors.successBg,
    fg: colors.success,
    label: "Volunteers",
  },
};

// ── Draw-mode toolbar (mode selector + color picker + image control) ──────────
function CanvasToolbar({
  mode,
  onMode,
  color,
  onColor,
  imageUrl,
  uploading,
  onPickImage,
  onRemoveImage,
}: {
  mode: DrawMode;
  onMode: (m: DrawMode) => void;
  color: string;
  onColor: (c: string) => void;
  imageUrl: string | null;
  uploading: boolean;
  onPickImage: () => void;
  onRemoveImage: () => void;
}) {
  const modes: {
    value: DrawMode;
    label: string;
    icon: "mouse-pointer" | "map-pin" | "square" | "circle" | "minus";
  }[] = [
    { value: "select", label: "Select", icon: "mouse-pointer" },
    { value: "pin", label: "Pin", icon: "map-pin" },
    { value: "rect", label: "Box", icon: "square" },
    { value: "circle", label: "Circle", icon: "circle" },
    { value: "line", label: "Line", icon: "minus" },
  ];

  return (
    <View className="flex-row flex-wrap items-center gap-3">
      {/* Mode selector */}
      <View className="flex-row items-center gap-1 rounded-md bg-sunken p-1">
        {modes.map((m) => {
          const active = mode === m.value;
          return (
            <Pressable
              key={m.value}
              onPress={() => onMode(m.value)}
              className="active:opacity-70"
            >
              <View
                className="flex-row items-center gap-1.5 rounded-sm px-2.5 py-1.5"
                style={{ backgroundColor: active ? colors.raised : "transparent" }}
              >
                <Icon
                  name={m.icon}
                  size={14}
                  color={active ? colors.ink : colors.muted}
                />
                <Text
                  className="text-xs font-semibold"
                  style={{ color: active ? colors.ink : colors.muted }}
                >
                  {m.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Color picker — only while a DRAW tool is active (sets the new-item
          color). When selecting, the floating bar handles color, so this is
          hidden to avoid two identical swatch rows. */}
      {mode !== "select" ? (
        <View className="flex-row items-center gap-1.5">
          <Text className="text-2xs font-semibold uppercase tracking-wide text-faint">
            Color
          </Text>
          {SHAPE_COLORS.map((c) => {
            const hex = optionColor(c).text;
            const active = color === c;
            return (
              <Pressable
                key={c}
                onPress={() => onColor(c)}
                className="active:opacity-70"
              >
                <View
                  className="h-6 w-6 items-center justify-center rounded-pill"
                  style={{
                    borderWidth: active ? 2 : 1,
                    borderColor: active ? colors.ink : colors.border,
                  }}
                >
                  <View
                    className="h-4 w-4 rounded-pill"
                    style={{ backgroundColor: hex }}
                  />
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* Image control (optional background) */}
      <View className="ml-auto flex-row items-center gap-2">
        {uploading ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : imageUrl == null ? (
          <Button
            title="Add background image"
            variant="ghost"
            icon="image"
            onPress={onPickImage}
          />
        ) : (
          <>
            <Button
              title="Replace image"
              variant="ghost"
              icon="upload"
              onPress={onPickImage}
            />
            <Button
              title="Remove"
              variant="ghost"
              icon="x"
              onPress={onRemoveImage}
            />
          </>
        )}
      </View>
    </View>
  );
}

// ── A single shape overlaid on the canvas (beneath the pins) ──────────────────
// Native-only (the web path uses the react-rnd shapes below). Same geometry as
// the shared read-only `ShapeView` (via `lineGeometry`/`percentPosition`/
// `shapeFill`), but wrapped in a Pressable for tap-to-select and emphasized
// (thicker, ink border) while selected.
function EditorShape({
  shape,
  selected,
  containerSize,
  onPress,
}: {
  shape: Shape;
  selected: boolean;
  containerSize: { width: number; height: number } | null;
  onPress: () => void;
}) {
  const hex = shapeHex(shape.color);
  const border = selected ? colors.ink : hex;

  if (shape.type === "line") {
    const geo = lineGeometry(shape, containerSize);
    if (!geo) return null;
    return (
      <Pressable
        onPress={onPress}
        style={{ position: "absolute", ...percentPosition(shape.x, shape.y) }}
      >
        <View
          style={{
            width: geo.length,
            height: selected ? 4 : 3,
            backgroundColor: hex,
            borderRadius: 2,
            // Rotate around the start point so the bar runs to the end point.
            transform: [{ rotateZ: `${geo.angleDeg}deg` }],
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
      </Pressable>
    );
  }

  // rect + circle: an absolutely-positioned box (circle = full border radius).
  const w = shape.w ?? DEFAULT_SHAPE_SIZE;
  const h = shape.h ?? DEFAULT_SHAPE_SIZE;
  return (
    <Pressable
      onPress={onPress}
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
          borderWidth: selected ? 3 : 2,
          borderColor: border,
          backgroundColor: shapeFill(shape.color),
          borderRadius: shape.type === "circle" ? 9999 : 8,
        }}
      />
      {shape.label ? (
        <View
          className="absolute rounded-sm px-1.5 py-0.5"
          style={{
            backgroundColor: "rgba(255,255,255,0.92)",
            left: 4,
            top: 4,
          }}
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
    </Pressable>
  );
}

// ── A single pin overlaid on the map ─────────────────────────────────────────
function Pin({
  marker,
  selected,
  onPress,
  onMove,
  toNorm,
}: {
  marker: Marker;
  selected: boolean;
  onPress: () => void;
  onMove: (x: number, y: number) => void;
  toNorm: (e: GestureResponderEvent) => { x: number; y: number } | null;
}) {
  const color = markerHex(marker.color);
  // Local drag position (normalized) while dragging; null = use the stored value.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const x = drag?.x ?? marker.x;
  const y = drag?.y ?? marker.y;

  const canDrag = true;

  return (
    <View
      // Center the pin on its point: shift left/up by half the badge.
      style={{
        position: "absolute",
        ...percentPosition(x, y),
        transform: [{ translateX: -MARKER_HALF }, { translateY: -MARKER_HALF }],
      }}
      // Drag handling via the responder system (web-safe). Tap is handled in
      // onResponderRelease so we don't fight the press handler.
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => canDrag}
      onResponderGrant={() => {
        dragged.current = false;
      }}
      onResponderMove={(e) => {
        const n = toNorm(e);
        if (n) {
          dragged.current = true;
          setDrag(n);
        }
      }}
      onResponderRelease={() => {
        if (dragged.current && drag) {
          onMove(drag.x, drag.y);
        } else {
          onPress();
        }
        setDrag(null);
        dragged.current = false;
      }}
    >
      <View className="flex-row items-center gap-1.5">
        {/* Colored dot */}
        <View
          className="h-4 w-4 rounded-pill border-2 border-white"
          style={{
            backgroundColor: color,
            ...(selected
              ? {
                  // Emphasis ring on the selected pin.
                  shadowColor: color,
                  shadowOpacity: 1,
                  shadowRadius: 0,
                  elevation: 4,
                  borderColor: colors.ink,
                }
              : {
                  shadowColor: "#000",
                  shadowOpacity: 0.25,
                  shadowRadius: 2,
                  shadowOffset: { width: 0, height: 1 },
                }),
          }}
        />
        {/* Label chip */}
        {marker.label ? (
          <View
            className="self-start rounded-sm px-1.5 py-0.5"
            style={{
              backgroundColor: "rgba(255,255,255,0.92)",
              ...(selected
                ? { borderWidth: 1, borderColor: colors.ink }
                : null),
            }}
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

// ── Web-only draggable/resizable rect & circle (react-rnd) ───────────────────
// Rendered only on web, inside a pointer-events:none overlay div so empty-canvas
// taps still reach the responder system. Each Rnd opts back into pointer events.
function WebShapeRnd({
  shape,
  selected,
  W,
  H,
  onSelect,
  onDragStop,
  onResizeStop,
}: {
  shape: Shape;
  selected: boolean;
  W: number;
  H: number;
  onSelect: () => void;
  onDragStop: (x: number, y: number) => void;
  onResizeStop: (w: number, h: number, x: number, y: number) => void;
}) {
  const hex = shapeHex(shape.color);
  const w = shape.w ?? DEFAULT_SHAPE_SIZE;
  const h = shape.h ?? DEFAULT_SHAPE_SIZE;

  return (
    <Rnd
      position={{ x: shape.x * W, y: shape.y * H }}
      size={{ width: w * W, height: h * H }}
      bounds="parent"
      enableResizing={{
        topLeft: true,
        topRight: true,
        bottomLeft: true,
        bottomRight: true,
        top: false,
        right: false,
        bottom: false,
        left: false,
      }}
      style={{ pointerEvents: "auto" }}
      onDragStart={onSelect}
      onDragStop={(_e, d) => onDragStop(d.x, d.y)}
      onResizeStop={(_e, _dir, ref, _delta, pos) =>
        onResizeStop(ref.offsetWidth, ref.offsetHeight, pos.x, pos.y)
      }
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          borderStyle: "solid",
          borderWidth: selected ? 3 : 2,
          borderColor: selected ? colors.ink : hex,
          backgroundColor: shapeFill(shape.color),
          borderRadius: shape.type === "circle" ? 9999 : 8,
          position: "relative",
        }}
      >
        {shape.label ? (
          <div
            style={{
              position: "absolute",
              left: 4,
              top: 4,
              backgroundColor: "rgba(255,255,255,0.92)",
              borderRadius: 4,
              padding: "1px 6px",
              fontSize: 12,
              fontWeight: 600,
              color: colors.ink,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "calc(100% - 8px)",
            }}
          >
            {shape.label}
          </div>
        ) : null}
      </div>
    </Rnd>
  );
}

// ── Web-only draggable marker pin (react-rnd, drag only) ─────────────────────
// Offset by ~half the pin (9px) so the dot sits on the stored point.
function WebMarkerRnd({
  marker,
  selected,
  W,
  H,
  onSelect,
  onDragStop,
}: {
  marker: Marker;
  selected: boolean;
  W: number;
  H: number;
  onSelect: () => void;
  onDragStop: (x: number, y: number) => void;
}) {
  const color = markerHex(marker.color);

  return (
    <Rnd
      position={{
        x: marker.x * W - MARKER_RND_OFFSET,
        y: marker.y * H - MARKER_RND_OFFSET,
      }}
      enableResizing={false}
      bounds="parent"
      style={{ pointerEvents: "auto" }}
      onDragStart={onSelect}
      onDragStop={(_e, d) => onDragStop(d.x, d.y)}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        {/* Colored dot */}
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: 9999,
            backgroundColor: color,
            borderStyle: "solid",
            borderWidth: 2,
            borderColor: selected ? colors.ink : "#fff",
            boxShadow: selected
              ? `0 0 0 2px ${color}`
              : "0 1px 2px rgba(0,0,0,0.25)",
          }}
        />
        {/* Label chip */}
        {marker.label ? (
          <div
            style={{
              backgroundColor: "rgba(255,255,255,0.92)",
              borderRadius: 4,
              padding: "1px 6px",
              fontSize: 12,
              fontWeight: 600,
              color: colors.ink,
              whiteSpace: "nowrap",
              ...(selected
                ? { borderStyle: "solid", borderWidth: 1, borderColor: colors.ink }
                : null),
            }}
          >
            {marker.label}
          </div>
        ) : null}
      </div>
    </Rnd>
  );
}

// ── Web-only draggable overlay circle (supply / volunteer, drag only) ────────
// A ~42px CIRCLE centered on its point: a supply shows its photo (or a colored
// info circle with the title's first letter / a package icon); a volunteer
// shows a green circle with the person's initials. Drag to reposition (commits
// normalized coords). Hovering reveals a floating name label above the circle;
// a click (NOT a drag) opens the read-only detail panel. Rendered inside the
// pointer-events:none overlay (it opts back into pointer events).
function WebPlacementCircle({
  placement,
  supply,
  volunteer,
  W,
  H,
  onDragStop,
  onOpenDetail,
  onSplit,
}: {
  placement: Placement;
  supply: SupplyItem | null;
  volunteer: VolunteerItem | null;
  W: number;
  H: number;
  onDragStop: (x: number, y: number) => void;
  onOpenDetail: () => void;
  /** Right-click action — peel one unit off a multi-quantity supply. */
  onSplit: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // A supply with more than one unit can be split into separate chips.
  const supplyQty =
    placement.kind === "supply" && typeof supply?.qty === "number"
      ? supply.qty
      : null;
  const splittable = supplyQty != null && supplyQty > 1;
  // Tracks whether the current pointer interaction actually dragged the circle,
  // so onDragStop can tell a click apart from a reposition.
  const movedRef = useRef(false);

  const isSupply = placement.kind === "supply";
  const ring = colors.raised; // white-ish ring so it reads on any background
  const baseLabel = isSupply
    ? supply?.title || placement.label || OVERLAY_STYLE.supply.label
    : volunteer?.name || placement.label || OVERLAY_STYLE.volunteer.label;
  // Prefix the quantity on multi-unit supplies so "5 × Mics" reads at a glance.
  const labelText = splittable ? `${supplyQty} × ${baseLabel}` : baseLabel;

  // Inner content: supply photo, or a colored circle with a letter/initials/icon.
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
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 9999,
          backgroundColor: colors.infoBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {letter ? (
          <span
            style={{ fontSize: 16, fontWeight: 700, color: colors.info }}
          >
            {letter}
          </span>
        ) : (
          <Icon name="package" size={18} color={colors.info} />
        )}
      </div>
    );
  } else {
    const text = initials(volunteer?.name ?? placement.label);
    inner = (
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 9999,
          backgroundColor: colors.successBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {text ? (
          <span
            style={{ fontSize: 14, fontWeight: 700, color: colors.success }}
          >
            {text}
          </span>
        ) : (
          <Icon name="users" size={18} color={colors.success} />
        )}
      </div>
    );
  }

  return (
    <Rnd
      // Offset by half the circle so it sits centered on the stored point.
      position={{ x: placement.x * W - CIRCLE_SIZE / 2, y: placement.y * H - CIRCLE_SIZE / 2 }}
      size={{ width: CIRCLE_SIZE, height: CIRCLE_SIZE }}
      enableResizing={false}
      bounds="parent"
      style={{ pointerEvents: "auto" }}
      onDragStart={() => {
        movedRef.current = false;
      }}
      onDrag={() => {
        movedRef.current = true;
      }}
      onDragStop={(_e, d) => {
        if (movedRef.current) {
          onDragStop(d.x + CIRCLE_SIZE / 2, d.y + CIRCLE_SIZE / 2);
        } else {
          // A click, not a drag — open the read-only detail panel.
          onOpenDetail();
        }
        movedRef.current = false;
      }}
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          // Right-click a multi-unit supply → peel one unit off as its own chip.
          if (splittable) {
            e.preventDefault();
            e.stopPropagation();
            onSplit();
          }
        }}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          cursor: "pointer",
        }}
      >
        {/* Hover label — floats just above the circle. Multi-unit supplies hint
            that right-click peels one off. */}
        {hovered ? (
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: "50%",
              transform: "translateX(-50%)",
              backgroundColor: "#fff",
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 12,
              fontWeight: 600,
              color: colors.ink,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            {labelText}
            {splittable ? (
              <div style={{ fontSize: 10, fontWeight: 500, color: colors.muted }}>
                Right-click to separate one
              </div>
            ) : null}
          </div>
        ) : null}

        {/* The circle: 2px ring + subtle shadow, content clipped to a circle. */}
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 9999,
            overflow: "hidden",
            borderStyle: "solid",
            borderWidth: 2,
            borderColor: ring,
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
            backgroundColor: ring,
          }}
        >
          {inner}
        </div>
      </div>
    </Rnd>
  );
}

// ── Read-only detail panel for a placed circle ───────────────────────────────
// A centered modal showing the joined supply/volunteer details (omitting null
// rows). Supplies show their photo + a labelled field list (with a tappable
// link); volunteers show tappable phone/email + team/status/service. Both offer
// "Remove from map" and a close button.
function PlacementDetailModal({
  detail,
  onClose,
  onRemove,
}: {
  detail: PlacementDetail | null;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <Modal
      visible={detail !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          {detail ? (
            <PlacementDetailBody
              detail={detail}
              onClose={onClose}
              onRemove={onRemove}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One labelled detail row — omitted entirely when `value` is empty. */
function DetailRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string | null | undefined;
  onPress?: () => void;
}) {
  if (value == null || value === "") return null;
  return (
    <View className="flex-row items-start gap-3 py-1.5">
      <Text
        className="text-2xs font-semibold uppercase tracking-wide text-faint"
        style={{ width: 88 }}
      >
        {label}
      </Text>
      {onPress ? (
        <Pressable onPress={onPress} className="flex-1 active:opacity-70">
          <Text className="text-sm" style={{ color: colors.info }}>
            {value}
          </Text>
        </Pressable>
      ) : (
        <Text className="flex-1 text-sm" style={{ color: colors.ink }}>
          {value}
        </Text>
      )}
    </View>
  );
}

function PlacementDetailBody({
  detail,
  onClose,
  onRemove,
}: {
  detail: PlacementDetail;
  onClose: () => void;
  onRemove: () => void;
}) {
  const style = OVERLAY_STYLE[detail.kind];
  const heading =
    detail.kind === "supply"
      ? detail.item?.title || detail.placement.label || style.label
      : detail.item?.name || detail.placement.label || style.label;

  return (
    <View>
      {/* Header: kind icon + heading + close. */}
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-3">
        <Icon name={style.icon} size={16} color={style.fg} />
        <Text
          className="flex-1 text-base font-semibold"
          style={{ color: colors.ink }}
          numberOfLines={2}
        >
          {heading}
        </Text>
        <Pressable
          onPress={onClose}
          className="h-8 w-8 items-center justify-center rounded-pill active:opacity-70"
          accessibilityLabel="Close"
        >
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 420 }}>
        <View className="px-4 py-3">
          {detail.kind === "supply" ? (
            <>
              {detail.item?.photoUrl ? (
                <Image
                  source={{ uri: detail.item.photoUrl }}
                  resizeMode="cover"
                  className="mb-3 w-full rounded-lg"
                  style={{ height: 180 }}
                />
              ) : null}
              <DetailRow label="Status" value={detail.item?.status} />
              <DetailRow label="Packed in" value={detail.item?.packedIn} />
              <DetailRow label="Source" value={detail.item?.source} />
              <DetailRow
                label="Qty"
                value={
                  detail.item?.qty != null ? String(detail.item.qty) : null
                }
              />
              <DetailRow
                label="Cost"
                value={
                  detail.item?.cost != null
                    ? `$${detail.item.cost}`
                    : null
                }
              />
              <DetailRow
                label="Link"
                value={detail.item?.link}
                onPress={
                  detail.item?.link
                    ? () => void Linking.openURL(detail.item!.link!)
                    : undefined
                }
              />
              <DetailRow label="Notes" value={detail.item?.notes} />
            </>
          ) : (
            <>
              <DetailRow
                label="Phone"
                value={detail.item?.phone}
                onPress={
                  detail.item?.phone
                    ? () => void Linking.openURL(`tel:${detail.item!.phone}`)
                    : undefined
                }
              />
              <DetailRow
                label="Email"
                value={detail.item?.email}
                onPress={
                  detail.item?.email
                    ? () =>
                        void Linking.openURL(`mailto:${detail.item!.email}`)
                    : undefined
                }
              />
              <DetailRow label="Team" value={detail.item?.team} />
              <DetailRow label="Status" value={detail.item?.status} />
              <DetailRow label="Service" value={detail.item?.service} />
            </>
          )}
        </View>
      </ScrollView>

      {/* Remove from map. */}
      <View className="border-t border-border px-4 py-3">
        <Button
          title="Remove from map"
          variant="danger"
          icon="trash-2"
          onPress={onRemove}
        />
      </View>
    </View>
  );
}

// ── Tray of UNPLACED overlay items (drop onto canvas center on tap) ──────────
// One panel per enabled layer, above the canvas. Tapping a chip places it at
// the canvas center; it then becomes a draggable placed chip and leaves here.
function OverlayTray({
  kind,
  items,
  onPlace,
}: {
  kind: PlacementKind;
  items: TrayItem[];
  onPlace: (refId: string) => void;
}) {
  const style = OVERLAY_STYLE[kind];
  return (
    <View className="rounded-lg border border-border bg-surface p-3">
      <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-faint">
        {style.label} — drag onto the map
      </Text>
      {items.length === 0 ? (
        <Text className="text-xs text-muted">
          All {style.label.toLowerCase()} placed
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {items.map((it) => (
            <Pressable
              key={it.refId}
              onPress={() => onPlace(it.refId)}
              className="active:opacity-70"
            >
              <View
                className="flex-row items-center gap-1.5 rounded-pill border px-2.5 py-1.5"
                style={{ backgroundColor: style.bg, borderColor: style.fg }}
              >
                <Icon name={style.icon} size={13} color={style.fg} />
                <Text
                  className="text-xs font-semibold"
                  style={{ color: colors.ink }}
                  numberOfLines={1}
                >
                  {it.label || style.label}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Web-only interactive line (select / move body / drag endpoints) ──────────
// react-rnd isn't suited to lines, so this is hand-rolled with raw DOM mouse
// events. The line bar uses the same geometry math as ShapeView (start at
// x*W,y*H, length=hypot, angle=atan2, transformOrigin "left center").
function WebLine({
  shape,
  selected,
  W,
  H,
  onSelect,
  onUpdate,
  clientToNorm,
}: {
  shape: Shape;
  selected: boolean;
  W: number;
  H: number;
  onSelect: () => void;
  onUpdate: (patch: {
    x?: number;
    y?: number;
    x2?: number;
    y2?: number;
  }) => void;
  clientToNorm: (clientX: number, clientY: number) => { x: number; y: number } | null;
}) {
  const hex = shapeHex(shape.color);

  // Stored normalized coords (fall back so a half-defined line still renders).
  const sx = shape.x;
  const sy = shape.y;
  const ex = shape.x2 ?? shape.x;
  const ey = shape.y2 ?? shape.y;

  // Live local override while dragging (commit on mouseup).
  const [local, setLocal] = useState<{
    x: number;
    y: number;
    x2: number;
    y2: number;
  } | null>(null);

  const cur = local ?? { x: sx, y: sy, x2: ex, y2: ey };

  // Pixel geometry from the shared helper (returns null before measurement or
  // on a non-finite coord, so we never feed NaN into left/top/width).
  const geo = lineGeometry(cur, { width: W, height: H });
  if (!geo) return null;
  const { x1: x1px, y1: y1px, x2: x2px, y2: y2px, length, angleDeg } = geo;

  // Drag one endpoint ("start" or "end") via document mouse events.
  function startEndpointDrag(
    end: "start" | "end",
    e: { stopPropagation: () => void; preventDefault: () => void },
  ) {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    let last = { x: cur.x, y: cur.y, x2: cur.x2, y2: cur.y2 };
    const onMove = (ev: MouseEvent) => {
      const n = clientToNorm(ev.clientX, ev.clientY);
      if (!n) return;
      last =
        end === "start"
          ? { ...last, x: n.x, y: n.y }
          : { ...last, x2: n.x, y2: n.y };
      setLocal(last);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setLocal(null);
      if (end === "start") onUpdate({ x: last.x, y: last.y });
      else onUpdate({ x2: last.x2, y2: last.y2 });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Drag the whole line body: translate both endpoints by the pointer delta.
  function startBodyDrag(e: {
    clientX: number;
    clientY: number;
    stopPropagation: () => void;
    preventDefault: () => void;
  }) {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const startNorm = clientToNorm(e.clientX, e.clientY);
    const base = { x: cur.x, y: cur.y, x2: cur.x2, y2: cur.y2 };
    let last = base;
    if (!startNorm) return;
    const onMove = (ev: MouseEvent) => {
      const n = clientToNorm(ev.clientX, ev.clientY);
      if (!n) return;
      const dx = n.x - startNorm.x;
      const dy = n.y - startNorm.y;
      last = {
        x: clamp01(base.x + dx),
        y: clamp01(base.y + dy),
        x2: clamp01(base.x2 + dx),
        y2: clamp01(base.y2 + dy),
      };
      setLocal(last);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setLocal(null);
      onUpdate({ x: last.x, y: last.y, x2: last.x2, y2: last.y2 });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const HANDLE = 12;

  return (
    <>
      {/* Line body — selectable + draggable (when selected). pointerEvents auto
          so it opts back in over the pointer-events:none overlay. */}
      <div
        onMouseDown={(e) => {
          if (selected) startBodyDrag(e);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        style={{
          position: "absolute",
          left: x1px,
          top: y1px,
          width: length,
          // A fatter hit area than the visible bar for easier grabbing.
          height: 14,
          marginTop: -7,
          transform: `rotateZ(${angleDeg}deg)`,
          transformOrigin: "left center",
          pointerEvents: "auto",
          cursor: selected ? "move" : "pointer",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            width: "100%",
            height: selected ? 4 : 3,
            backgroundColor: hex,
            borderRadius: 2,
          }}
        />
      </div>

      {/* Label chip near the start point. */}
      {shape.label ? (
        <div
          style={{
            position: "absolute",
            left: x1px,
            top: y1px + 6,
            backgroundColor: "rgba(255,255,255,0.92)",
            borderRadius: 4,
            padding: "1px 6px",
            fontSize: 12,
            fontWeight: 600,
            color: colors.ink,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {shape.label}
        </div>
      ) : null}

      {/* Endpoint handles — only while selected. */}
      {selected ? (
        <>
          <div
            onMouseDown={(e) => startEndpointDrag("start", e)}
            style={{
              position: "absolute",
              left: x1px - HANDLE / 2,
              top: y1px - HANDLE / 2,
              width: HANDLE,
              height: HANDLE,
              borderRadius: 9999,
              backgroundColor: "#fff",
              borderStyle: "solid",
              borderWidth: 2,
              borderColor: colors.ink,
              pointerEvents: "auto",
              cursor: "grab",
            }}
          />
          <div
            onMouseDown={(e) => startEndpointDrag("end", e)}
            style={{
              position: "absolute",
              left: x2px - HANDLE / 2,
              top: y2px - HANDLE / 2,
              width: HANDLE,
              height: HANDLE,
              borderRadius: 9999,
              backgroundColor: "#fff",
              borderStyle: "solid",
              borderWidth: 2,
              borderColor: colors.ink,
              pointerEvents: "auto",
              cursor: "grab",
            }}
          />
        </>
      ) : null}
    </>
  );
}

// ── Canva-style floating contextual top bar ──────────────────────────────────
// Shown only when a shape or marker is selected. A single horizontal pill of
// controls floating at the top-center of the canvas: color swatches, a label
// field, delete, and a close button.
function ContextualBar({
  color,
  label,
  onColor,
  onLabel,
  onDelete,
  onClose,
}: {
  color: string;
  label: string;
  onColor: (color: string) => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <View
      pointerEvents="auto"
      className="absolute left-0 right-0 top-2 z-50 items-center"
    >
      <View
        // Capture the responder so taps on the bar don't bubble to the canvas
        // (which would clear the selection in Select mode).
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => {}}
        className="flex-row items-center gap-2 rounded-pill border border-border bg-raised px-2.5 py-2"
        style={{
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
          ...(Platform.OS === "web"
            ? ({ boxShadow: "0 6px 20px rgba(0,0,0,0.18)" } as any)
            : null),
        }}
      >
        {/* Color swatches */}
        <View className="flex-row items-center gap-1">
          {SHAPE_COLORS.map((c) => {
            const hex = optionColor(c).text;
            const active = color === c;
            return (
              <Pressable
                key={c}
                onPress={() => onColor(c)}
                className="active:opacity-70"
              >
                <View
                  className="h-6 w-6 items-center justify-center rounded-pill"
                  style={{
                    borderWidth: active ? 2 : 1,
                    borderColor: active ? colors.ink : colors.border,
                  }}
                >
                  <View
                    className="h-3.5 w-3.5 rounded-pill"
                    style={{ backgroundColor: hex }}
                  />
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* Divider */}
        <View
          style={{ width: 1, height: 22, backgroundColor: colors.border }}
        />

        {/* Compact label field — commits on blur + Enter (onEndEditing is
            unreliable on RN-web). Local state so typing shows immediately. */}
        <ContextualLabelInput label={label} onLabel={onLabel} />

        {/* Delete */}
        <Pressable
          onPress={onDelete}
          className="h-8 w-8 items-center justify-center rounded-pill active:opacity-70"
        >
          <Icon name="trash-2" size={17} color={colors.danger} />
        </Pressable>

        {/* Done / deselect */}
        <Pressable
          onPress={onClose}
          className="h-8 w-8 items-center justify-center rounded-pill active:opacity-70"
        >
          <Icon name="x" size={17} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

/** Label input for the contextual bar — controlled, commits on blur + Enter. */
function ContextualLabelInput({
  label,
  onLabel,
}: {
  label: string;
  onLabel: (label: string) => void;
}) {
  const [text, setText] = useState(label);
  // Resync when the selected element changes.
  useEffect(() => setText(label), [label]);
  return (
    <View style={{ width: 140 }}>
      <TextField
        value={text}
        onChangeText={setText}
        placeholder="Label"
        onBlur={() => onLabel(text)}
        onSubmitEditing={() => onLabel(text)}
      />
    </View>
  );
}

/**
 * SITE MAP: sketch the venue with shapes and labelled pins. A background image
 * is optional — the canvas works blank.
 *
 * Interaction model:
 *  Markers:
 *   - Pin mode: tap canvas → add a marker (toolbar color, empty label), then
 *     back to Select with the new marker selected.
 *   - Tap/drag a marker → select / reposition it.
 *  Shapes:
 *   - Box / Circle mode: tap canvas → add that shape, then back to Select.
 *   - Line mode: drag on the canvas → live preview, release creates the line,
 *     then back to Select.
 *   - Drag/corner-resize on web (react-rnd); tap to select. Lines (web): tap to
 *     select, drag body to move, drag endpoint handles to reshape.
 *   - Keyboard (web): Delete/Backspace removes the selection; Cmd/Ctrl+D
 *     duplicates; Cmd/Ctrl+C/X/V copy/cut/paste the selected item.
 *  Select mode:
 *   - Tap a pin/shape → select it (shows the floating contextual top bar).
 *   - Tap empty canvas → deselect.
 */
/**
 * SITE MAP EDITOR — the venue-map canvas, extracted so it renders BOTH as the
 * standalone `/event/[id]/site-map` route AND inline as the site_map module's
 * section on the event screen. When `embedded`, the page chrome (Screen wrapper,
 * back breadcrumb, PageHeader) is dropped so it sits inside the event layout.
 */
/**
 * Where this editor's map lives. An EVENT scope is the live venue (with
 * supply/volunteer overlays); a TEMPLATE scope is the reusable blueprint
 * (background + shapes + markers only — placements don't exist on templates and
 * their UI is hidden). Callers that pass only `eventId` get an event scope.
 */
export type SiteMapScope =
  | { kind: "event"; eventId: string }
  | { kind: "template"; eventTypeId: string };

export function SiteMapEditor({
  eventId: eventIdProp,
  scope: scopeProp,
  embedded = false,
}: {
  /** Legacy event-scoped entry point — kept so existing callers don't break. */
  eventId?: string;
  /** Explicit scope (event or template). Falls back to `eventId` when omitted. */
  scope?: SiteMapScope;
  embedded?: boolean;
}) {
  const router = useRouter();
  // Derive the scope: an explicit `scope` wins; otherwise build an event scope
  // from the legacy `eventId` prop. One of the two is always supplied.
  const scope: SiteMapScope =
    scopeProp ?? { kind: "event", eventId: eventIdProp! };

  // Convex scope arg (matches the `scopeArg` union in apps/convex/siteMap.ts).
  const apiScope =
    scope.kind === "event"
      ? ({ kind: "event", eventId: scope.eventId as any } as const)
      : ({ kind: "template", eventTypeId: scope.eventTypeId as any } as const);
  // Stable string identity of the scope — used as the keyboard effect dep.
  const scopeKey =
    scope.kind === "event"
      ? `event:${scope.eventId}`
      : `template:${scope.eventTypeId}`;
  // Only event scopes have an underlying event (for the header eyebrow); the
  // supply/volunteer overlay layers now work on both scopes via `apiScope`.
  const eventData = useQuery(
    api.events.get,
    scope.kind === "event" ? { eventId: scope.eventId as any } : "skip",
  );
  const data = useQuery(api.siteMap.get, { scope: apiScope });
  const overlays = useQuery(api.siteMap.overlays, { scope: apiScope });

  // Optimistic: update the local overlays cache immediately so a dragged chip
  // stays put instead of snapping to its old spot until the server round-trips.
  // Keyed by the active scope (event or template); both surfaces drag placements.
  const placeOrMove = useMutation(api.siteMap.placeOrMove).withOptimisticUpdate(
    (store, { scope: optScope, kind, refId, x, y }) => {
      const cur = store.getQuery(api.siteMap.overlays, { scope: optScope });
      if (!cur) return;
      if (
        !cur.placements.some(
          (p: Placement) => p.kind === kind && p.refId === refId,
        )
      )
        return; // new placement (insert) — no flicker to fix on create
      store.setQuery(api.siteMap.overlays, { scope: optScope }, {
        ...cur,
        placements: cur.placements.map((p: Placement) =>
          p.kind === kind && p.refId === refId ? { ...p, x, y } : p,
        ),
      });
    },
  );
  const removePlacement = useMutation(api.siteMap.removePlacement);
  const splitSupplyPlacement = useMutation(api.siteMap.splitSupplyPlacement);

  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const setImage = useMutation(api.siteMap.setImage);
  const addMarker = useMutation(api.siteMap.addMarker);
  const updateMarker = useMutation(api.siteMap.updateMarker).withOptimisticUpdate(
    (store, { markerId, ...patch }) => {
      const cur = store.getQuery(api.siteMap.get, { scope: apiScope });
      if (!cur) return;
      store.setQuery(api.siteMap.get, { scope: apiScope }, {
        ...cur,
        markers: cur.markers.map((m: Marker) =>
          m._id === markerId ? { ...m, ...patch } : m,
        ),
      });
    },
  );
  const removeMarker = useMutation(api.siteMap.removeMarker);
  const addShape = useMutation(api.siteMap.addShape);
  const updateShape = useMutation(api.siteMap.updateShape).withOptimisticUpdate(
    (store, { shapeId, ...patch }) => {
      const cur = store.getQuery(api.siteMap.get, { scope: apiScope });
      if (!cur) return;
      store.setQuery(api.siteMap.get, { scope: apiScope }, {
        ...cur,
        shapes: cur.shapes.map((s: Shape) =>
          s._id === shapeId ? { ...s, ...patch } : s,
        ),
      });
    },
  );
  const removeShape = useMutation(api.siteMap.removeShape);

  const [uploading, setUploading] = useState(false);
  // Overlay layer visibility — supplies / volunteers chips + trays. Independent
  // of the shape/marker draw state; toggling a layer shows its placed chips and
  // its tray of not-yet-placed items.
  // Default both overlay layers ON so the planner sees volunteers and equipment
  // on the map straight away (they can still toggle either off).
  const [showSupplies, setShowSupplies] = useState(true);
  const [showVolunteers, setShowVolunteers] = useState(true);
  // Which placed circle's read-only detail panel is open (null = closed).
  const [detailPlacement, setDetailPlacement] = useState<PlacementDetail | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  // Draw mode + the color new shapes are created with.
  const [mode, setMode] = useState<DrawMode>("select");
  const [shapeColor, setShapeColor] = useState<string>(DEFAULT_SHAPE_COLOR);
  // In-progress line being drawn (normalized start + current end) — live preview.
  const [lineDraft, setLineDraft] = useState<{
    x: number;
    y: number;
    x2: number;
    y2: number;
  } | null>(null);
  // True once a line-draw drag has moved past the threshold (so a static tap
  // in Line mode doesn't create a zero-length line).
  const lineDraftMovedRef = useRef(false);
  // Natural image dimensions → preserve aspect ratio in the coordinate space.
  const [aspect, setAspect] = useState<number | null>(null);
  // Container rect in window coords (for drag) + size (for tap math).
  const containerRef = useRef<View>(null);
  const [containerRect, setContainerRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // ── Keyboard-shortcut plumbing (web) ──────────────────────────────────────
  // Refs updated each render so the keydown handler reads fresh selection/data
  // without re-subscribing the listener (avoids stale closures).
  const selectionRef = useRef<{
    shapeId: string | null;
    markerId: string | null;
  }>({ shapeId: null, markerId: null });
  const shapesRef = useRef<Shape[]>([]);
  const markersRef = useRef<Marker[]>([]);
  // In-memory clipboard for copy/cut/paste — survives re-renders via the ref.
  const clipboardRef = useRef<
    | { kind: "shape"; data: Shape }
    | { kind: "marker"; data: Marker }
    | null
  >(null);

  // ── Undo / redo (in-memory operation stack) ───────────────────────────────
  // Every user-initiated shape/marker mutation is recorded as a reversible Op
  // via the op-* helpers below, so Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z can replay
  // it. History is intentionally not persisted across reloads.
  const undoStack = useRef<Op[]>([]);
  const redoStack = useRef<Op[]>([]);

  function pushOp(op: Op) {
    undoStack.current.push(op);
    redoStack.current = [];
  }
  async function doUndo() {
    const op = undoStack.current.pop();
    if (!op) return;
    await op.undo();
    redoStack.current.push(op);
  }
  async function doRedo() {
    const op = redoStack.current.pop();
    if (!op) return;
    await op.redo();
    undoStack.current.push(op);
  }

  // Create a shape and record it. The created id lives in a mutable closure so
  // that redo (which recreates the shape) keeps undo deleting the right row.
  async function opCreateShape(
    props: Omit<Parameters<typeof addShape>[0], "scope">,
  ): Promise<string> {
    const id = (await addShape({ scope: apiScope, ...props })) as string;
    let curId = id;
    pushOp({
      undo: async () => {
        await removeShape({ shapeId: curId as any });
      },
      redo: async () => {
        curId = (await addShape({ scope: apiScope, ...props })) as string;
      },
    });
    return curId;
  }

  async function opCreateMarker(
    props: Omit<Parameters<typeof addMarker>[0], "scope">,
  ): Promise<string> {
    const id = (await addMarker({ scope: apiScope, ...props })) as string;
    let curId = id;
    pushOp({
      undo: async () => {
        await removeMarker({ markerId: curId as any });
      },
      redo: async () => {
        curId = (await addMarker({ scope: apiScope, ...props })) as string;
      },
    });
    return curId;
  }

  // Patch a shape and record the before-values (only the keys being patched).
  function opPatchShape(
    id: string,
    patch: Omit<Parameters<typeof updateShape>[0], "shapeId">,
  ) {
    const cur = shapesRef.current.find((s) => s._id === id);
    if (!cur) {
      void updateShape({ shapeId: id as any, ...patch });
      return;
    }
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      before[key] = (cur as any)[key];
    }
    void updateShape({ shapeId: id as any, ...patch });
    pushOp({
      undo: async () => {
        await updateShape({ shapeId: id as any, ...(before as any) });
      },
      redo: async () => {
        await updateShape({ shapeId: id as any, ...patch });
      },
    });
  }

  function opPatchMarker(
    id: string,
    patch: Omit<Parameters<typeof updateMarker>[0], "markerId">,
  ) {
    const cur = markersRef.current.find((m) => m._id === id);
    if (!cur) {
      void updateMarker({ markerId: id as any, ...patch });
      return;
    }
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      before[key] = (cur as any)[key];
    }
    void updateMarker({ markerId: id as any, ...patch });
    pushOp({
      undo: async () => {
        await updateMarker({ markerId: id as any, ...(before as any) });
      },
      redo: async () => {
        await updateMarker({ markerId: id as any, ...patch });
      },
    });
  }

  // Delete a shape and record enough to recreate it. The recreated id lives in
  // a mutable closure so repeated undo/redo stays consistent.
  function opDeleteShape(id: string) {
    const cur = shapesRef.current.find((s) => s._id === id);
    if (!cur) {
      void removeShape({ shapeId: id as any });
      return;
    }
    const data = cur;
    void removeShape({ shapeId: id as any });
    let curId = id;
    pushOp({
      undo: async () => {
        curId = (await addShape({
          scope: apiScope,
          type: data.type,
          x: data.x,
          y: data.y,
          w: data.w ?? undefined,
          h: data.h ?? undefined,
          x2: data.x2 ?? undefined,
          y2: data.y2 ?? undefined,
          color: data.color ?? undefined,
          label: data.label ?? undefined,
        })) as string;
      },
      redo: async () => {
        await removeShape({ shapeId: curId as any });
      },
    });
  }

  function opDeleteMarker(id: string) {
    const cur = markersRef.current.find((m) => m._id === id);
    if (!cur) {
      void removeMarker({ markerId: id as any });
      return;
    }
    const data = cur;
    void removeMarker({ markerId: id as any });
    let curId = id;
    pushOp({
      undo: async () => {
        curId = (await addMarker({
          scope: apiScope,
          x: data.x,
          y: data.y,
          label: data.label ?? undefined,
          color: data.color ?? undefined,
        })) as string;
      },
      redo: async () => {
        await removeMarker({ markerId: curId as any });
      },
    });
  }

  // Upload a File (web) / Blob (native) and point the site map at it.
  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      await setImage({ scope: apiScope, storageId });
      setAspect(null);
    } catch {
      // Swallow; the canvas simply stays as-is on failure.
    } finally {
      setUploading(false);
    }
  }

  function pickImage() {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void uploadBlob(file, file.type || "image/jpeg");
      };
      input.click();
    }
    // Native picker intentionally omitted — WEB is the test target. Native
    // builds fall back to "no image" until an image-picker path is added.
  }

  function removeImage() {
    setAspect(null);
    void setImage({ scope: apiScope, storageId: null });
  }

  function measureContainer() {
    const node = containerRef.current;
    if (node && typeof (node as any).measureInWindow === "function") {
      (node as any).measureInWindow(
        (x: number, y: number, width: number, height: number) => {
          setContainerRect({ x, y, width, height });
        },
      );
    }
  }

  function onContainerLayout(e: LayoutChangeEvent) {
    // width/height from layout are reliable (used to draw lines + size popovers);
    // also refresh the window x/y for popover anchoring.
    const { width, height } = e.nativeEvent.layout;
    setContainerRect((prev) => ({
      x: prev?.x ?? 0,
      y: prev?.y ?? 0,
      width,
      height,
    }));
    measureContainer();
  }

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedShapeId(null);
  }, []);

  // Set on a shape/marker pointer-down so the canvas tap (which also fires via
  // the responder system) doesn't immediately clear the fresh selection.
  const interactingRef = useRef(false);
  const selectShape = useCallback((id: string) => {
    interactingRef.current = true;
    setSelectedId(null);
    setSelectedShapeId(id);
  }, []);
  const selectMarker = useCallback((id: string) => {
    interactingRef.current = true;
    setSelectedShapeId(null);
    setSelectedId(id);
  }, []);

  /**
   * Normalized (0..1) position of a pointer event inside the canvas. Reads the
   * container's REAL DOM rect (the ref is the host node on web) + the pointer's
   * page coords each time — robust where RN-web's locationX / measureInWindow
   * are unreliable (which made everything snap to the corner).
   */
  const eventToNorm = useCallback(
    (e: GestureResponderEvent): { x: number; y: number } | null => {
      const node: any = containerRef.current;
      if (!node || typeof node.getBoundingClientRect !== "function")
        return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const ne: any = e.nativeEvent;
      const sx = typeof window !== "undefined" ? window.scrollX || 0 : 0;
      const sy = typeof window !== "undefined" ? window.scrollY || 0 : 0;
      const clientX =
        ne.clientX != null
          ? ne.clientX
          : ne.pageX != null
            ? ne.pageX - sx
            : null;
      const clientY =
        ne.clientY != null
          ? ne.clientY
          : ne.pageY != null
            ? ne.pageY - sy
            : null;
      if (clientX == null || clientY == null) return null;
      return {
        x: clamp01((clientX - rect.left) / rect.width),
        y: clamp01((clientY - rect.top) / rect.height),
      };
    },
    [],
  );

  /**
   * Normalized (0..1) position from raw DOM client coords (web only). Used by
   * the hand-rolled line endpoint/body drag, which listens to document mouse
   * events rather than the RN responder system.
   */
  const clientToNorm = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const node: any = containerRef.current;
      if (!node || typeof node.getBoundingClientRect !== "function")
        return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: clamp01((clientX - rect.left) / rect.width),
        y: clamp01((clientY - rect.top) / rect.height),
      };
    },
    [],
  );

  // Line draw-to-draw: pointer-down sets the start point (= end, zero length).
  function onCanvasGrant(e: GestureResponderEvent) {
    if (mode !== "line") return;
    if (interactingRef.current) return;
    const n = eventToNorm(e);
    if (!n) return;
    lineDraftMovedRef.current = false;
    setLineDraft({ x: n.x, y: n.y, x2: n.x, y2: n.y });
  }

  // Line draw-to-draw: dragging updates the live end point.
  function onCanvasMove(e: GestureResponderEvent) {
    if (mode !== "line") return;
    const n = eventToNorm(e);
    if (!n) return;
    lineDraftMovedRef.current = true;
    setLineDraft((prev) =>
      prev ? { ...prev, x2: n.x, y2: n.y } : prev,
    );
  }

  // Line draw-to-draw: pointer-up creates the line if the drag actually moved,
  // then returns to Select with the new line selected. Otherwise cancels.
  function onCanvasLineRelease() {
    const draft = lineDraft;
    setLineDraft(null);
    if (!draft) return;
    const moved =
      lineDraftMovedRef.current &&
      Math.hypot(draft.x2 - draft.x, draft.y2 - draft.y) > 0.01;
    lineDraftMovedRef.current = false;
    if (!moved) return;
    void opCreateShape({
      type: "line",
      x: draft.x,
      y: draft.y,
      x2: draft.x2,
      y2: draft.y2,
      color: shapeColor,
    }).then((newId) => {
      setMode("select");
      setSelectedId(null);
      setSelectedShapeId(newId);
    });
  }

  // Tap on the canvas. Behavior depends on the active draw mode.
  function onCanvasPress(e: GestureResponderEvent) {
    // A shape/marker was just tapped (it set the flag) — don't treat this as an
    // empty-canvas tap that would clear the selection or add something.
    if (interactingRef.current) {
      interactingRef.current = false;
      return;
    }
    const n = eventToNorm(e);
    if (!n) return;
    const nx = n.x;
    const ny = n.y;

    // Pin: drop a marker (toolbar color, empty label), then back to Select.
    if (mode === "pin") {
      void opCreateMarker({
        x: nx,
        y: ny,
        color: shapeColor,
        label: "",
      }).then((newId) => {
        setMode("select");
        setSelectedShapeId(null);
        setSelectedId(newId);
      });
      return;
    }

    // Box / Circle: drop the shape (top-left at tap), then return to Select.
    if (mode === "rect" || mode === "circle") {
      void opCreateShape({
        type: mode,
        x: nx,
        y: ny,
        w: DEFAULT_SHAPE_SIZE,
        h: DEFAULT_SHAPE_SIZE,
        color: shapeColor,
      }).then((newId) => {
        setMode("select");
        setSelectedId(null);
        setSelectedShapeId(newId);
      });
      return;
    }

    // Line mode is handled by drag-to-draw (onResponderGrant/Move + the line
    // release handler), not by this tap handler.
    if (mode === "line") return;

    // Select mode: tapping empty canvas just clears the selection. Pins and
    // shapes are repositioned via drag (react-rnd / responder), not tap.
    clearSelection();
  }

  // ── Keyboard shortcuts (web only) ─────────────────────────────────────────
  // Acts on the selected shape/marker. Reads selection + data from refs so the
  // listener stays mounted for the screen's lifetime without stale closures.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const off = 0.03; // duplicate/paste offset (normalized)

    // Re-create a shape (duplicate/paste) offset by +off, then select it.
    function spawnShape(src: Shape) {
      void opCreateShape({
        type: src.type,
        x: clamp01(src.x + off),
        y: clamp01(src.y + off),
        w: src.w ?? undefined,
        h: src.h ?? undefined,
        x2: src.x2 != null ? clamp01(src.x2 + off) : undefined,
        y2: src.y2 != null ? clamp01(src.y2 + off) : undefined,
        color: src.color ?? undefined,
        label: src.label ?? undefined,
      }).then((newId) => {
        setSelectedId(null);
        setSelectedShapeId(newId);
      });
    }

    function spawnMarker(src: Marker) {
      void opCreateMarker({
        x: clamp01(src.x + off),
        y: clamp01(src.y + off),
        label: src.label ?? "",
        color: src.color ?? undefined,
      }).then((newId) => {
        setSelectedShapeId(null);
        setSelectedId(newId);
      });
    }

    function onKeyDown(e: KeyboardEvent) {
      // Don't hijack typing in the label field (or any text input).
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const { shapeId, markerId } = selectionRef.current;
      const shape = shapeId
        ? shapesRef.current.find((s) => s._id === shapeId) ?? null
        : null;
      const marker = markerId
        ? markersRef.current.find((m) => m._id === markerId) ?? null
        : null;
      const mod = e.metaKey || e.ctrlKey;

      // Delete / Backspace — remove the selected item.
      if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        if (shape) {
          opDeleteShape(shape._id);
          setSelectedShapeId(null);
        } else if (marker) {
          opDeleteMarker(marker._id);
          setSelectedId(null);
        }
        return;
      }

      if (!mod) return;
      const key = e.key.toLowerCase();

      // Cmd/Ctrl+Z — undo; Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) — redo. These act
      // on the operation stack, independent of the current selection.
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) void doRedo();
        else void doUndo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        void doRedo();
        return;
      }

      // Cmd/Ctrl+D — duplicate.
      if (key === "d") {
        e.preventDefault();
        if (shape) spawnShape(shape);
        else if (marker) spawnMarker(marker);
        return;
      }

      // Cmd/Ctrl+C — copy into the in-memory clipboard.
      if (key === "c") {
        if (shape) clipboardRef.current = { kind: "shape", data: shape };
        else if (marker) clipboardRef.current = { kind: "marker", data: marker };
        return;
      }

      // Cmd/Ctrl+X — copy then delete.
      if (key === "x") {
        if (shape) {
          clipboardRef.current = { kind: "shape", data: shape };
          opDeleteShape(shape._id);
          setSelectedShapeId(null);
        } else if (marker) {
          clipboardRef.current = { kind: "marker", data: marker };
          opDeleteMarker(marker._id);
          setSelectedId(null);
        }
        return;
      }

      // Cmd/Ctrl+V — paste the clipboard contents (offset + select).
      if (key === "v") {
        e.preventDefault();
        const clip = clipboardRef.current;
        if (!clip) return;
        if (clip.kind === "shape") spawnShape(clip.data);
        else spawnMarker(clip.data);
        return;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // Mutations are stable; selection/data are read from refs. Re-bind only when
    // the scope identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // In template scope there's no event to load, so only gate on the map data.
  const chromeLoading =
    data === undefined || (scope.kind === "event" && eventData === undefined);

  const eventName = eventData?.event?.name ?? "Event";
  const markers = (data?.markers ?? []) as Marker[];
  const shapes = (data?.shapes ?? []) as Shape[];
  const imageUrl = data?.imageUrl ?? null;
  const selected = markers.find((m) => m._id === selectedId) ?? null;
  const selectedShape =
    shapes.find((s) => s._id === selectedShapeId) ?? null;

  // Keep the keyboard-shortcut refs in sync with the latest render.
  selectionRef.current = { shapeId: selectedShapeId, markerId: selectedId };
  shapesRef.current = shapes;
  markersRef.current = markers;

  // Measured canvas pixel size — used to convert normalized coords for react-rnd.
  const W = containerRect?.width ?? 0;
  const H = containerRect?.height ?? 0;

  // ── Overlay layers (supplies / volunteers) ────────────────────────────────
  // Placements for each kind, plus the not-yet-placed items that fill its tray.
  const placements = (overlays?.placements ?? []) as Placement[];
  const supplyItems = (overlays?.supplies ?? []) as SupplyItem[];
  const volunteerItems = (overlays?.volunteers ?? []) as VolunteerItem[];
  // Not-yet-placed items per layer, recomputed only when placements/items change.
  const unplacedSupplies = useMemo<TrayItem[]>(() => {
    const placed = new Set(
      placements.filter((p) => p.kind === "supply").map((p) => p.refId),
    );
    return supplyItems
      .filter((s) => !placed.has(s.refId))
      .map((s) => ({ refId: s.refId, label: s.title }));
  }, [placements, supplyItems]);
  const unplacedVolunteers = useMemo<TrayItem[]>(() => {
    const placed = new Set(
      placements.filter((p) => p.kind === "volunteer").map((p) => p.refId),
    );
    return volunteerItems
      .filter((vv) => !placed.has(vv.refId))
      .map((vv) => ({ refId: vv.refId, label: vv.name }));
  }, [placements, volunteerItems]);

  // Live line-draw preview geometry (pixels) from the shared helper — null when
  // not drawing, before measurement, or on a non-finite coord.
  const draftGeo = useMemo(
    () => (lineDraft ? lineGeometry(lineDraft, { width: W, height: H }) : null),
    [lineDraft, W, H],
  );

  // NOTE: keep this loading guard AFTER all hooks (incl. the useMemos above).
  // An early return placed before them causes "rendered more hooks than during
  // the previous render" once the data loads. The derived consts above are all
  // null-safe (optional chaining) so they're fine to compute while loading.
  if (chromeLoading) {
    if (embedded) return <ActivityIndicator color={colors.accent} />;
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "Site map" }} />
        <Screen loading />
      </>
    );
  }

  // The hint that runs beneath the toolbar, based on mode + selection.
  let hint: string;
  if (mode === "pin") {
    hint = "Tap the canvas to drop a pin.";
  } else if (mode === "line") {
    hint = "Drag on the canvas to draw a line.";
  } else if (mode === "rect" || mode === "circle") {
    hint = "Tap the canvas to place the shape.";
  } else if (selectedShape || selected) {
    hint = "Drag to reposition · use the bar above to recolor, label, or delete.";
  } else {
    hint = "Tap a pin or shape to edit it. Use the toolbar to add more.";
  }

  const canvas = (
        <View className="gap-4">
          {/* Draw-mode toolbar + image control */}
          <CanvasToolbar
            mode={mode}
            onMode={(m) => {
              setMode(m);
              setLineDraft(null);
              clearSelection();
            }}
            color={shapeColor}
            onColor={setShapeColor}
            imageUrl={imageUrl}
            uploading={uploading}
            onPickImage={pickImage}
            onRemoveImage={removeImage}
          />

          {/* Overlay layer toggles — show/hide the supplies & volunteers
              chips on the canvas plus their trays. Independent of draw mode.
              On TEMPLATE scope these drop the template's supplies (templateItems)
              and placeholder crew (templatePeople); on EVENT scope, the event's
              real supplies + volunteers. Both write scope-keyed placements. */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-2xs font-semibold uppercase tracking-wide text-faint">
              Layers
            </Text>
            {(["supply", "volunteer"] as const).map((kind) => {
              const style = OVERLAY_STYLE[kind];
              const active = kind === "supply" ? showSupplies : showVolunteers;
              const toggle =
                kind === "supply"
                  ? () => setShowSupplies((s) => !s)
                  : () => setShowVolunteers((s) => !s);
              return (
                <Pressable
                  key={kind}
                  onPress={toggle}
                  className="active:opacity-70"
                >
                  <View
                    className="flex-row items-center gap-1.5 rounded-pill border px-3 py-1.5"
                    style={{
                      backgroundColor: active ? style.bg : "transparent",
                      borderColor: active ? style.fg : colors.border,
                    }}
                  >
                    <Icon
                      name={style.icon}
                      size={14}
                      color={active ? style.fg : colors.muted}
                    />
                    <Text
                      className="text-xs font-semibold"
                      style={{ color: active ? colors.ink : colors.muted }}
                    >
                      {style.label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* Trays of not-yet-placed items for each enabled layer. */}
          {showSupplies ? (
            <OverlayTray
              kind="supply"
              items={unplacedSupplies}
              onPlace={(refId) =>
                void placeOrMove({
                  scope: apiScope,
                  kind: "supply",
                  refId,
                  x: 0.5,
                  y: 0.5,
                })
              }
            />
          ) : null}
          {showVolunteers ? (
            <OverlayTray
              kind="volunteer"
              items={unplacedVolunteers}
              onPlace={(refId) =>
                void placeOrMove({
                  scope: apiScope,
                  kind: "volunteer",
                  refId,
                  x: 0.5,
                  y: 0.5,
                })
              }
            />
          ) : null}

          <Text className="text-sm text-muted">{hint}</Text>

          {/* Coordinate space: the canvas + absolutely-positioned shapes & pins. */}
          <View
            className="w-full self-center"
            style={{ maxWidth: MAX_MAP_WIDTH }}
          >
            <View
              ref={containerRef}
              onLayout={onContainerLayout}
              // Use the responder system (not Pressable.onPress) so taps carry
              // reliable pageX/pageY. Child pins/shapes grab their own taps.
              onStartShouldSetResponder={() => true}
              // In Line mode we need move events to drive the live draw preview.
              onMoveShouldSetResponder={() => mode === "line"}
              onResponderGrant={onCanvasGrant}
              onResponderMove={onCanvasMove}
              onResponderRelease={(e) => {
                // In Line mode, a draft means we were drawing — finalize/cancel
                // the line instead of running the generic tap handler.
                if (mode === "line" && lineDraft) {
                  onCanvasLineRelease();
                  return;
                }
                onCanvasPress(e);
              }}
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
                  // Blank canvas: cream surface + subtle dotted grid + a faint hint.
                  <View
                    className="h-full w-full items-center justify-center"
                    style={{
                      backgroundColor: colors.surface,
                      ...(Platform.OS === "web"
                        ? ({
                            backgroundImage: `radial-gradient(${colors.borderStrong} 1px, transparent 1px)`,
                            backgroundSize: "20px 20px",
                          } as any)
                        : null),
                    }}
                  >
                    {shapes.length === 0 && markers.length === 0 ? (
                      <Text className="text-sm font-medium text-faint">
                        Pick a tool above to start sketching
                      </Text>
                    ) : null}
                  </View>
                )}

                {/*
                 * Web: lines render via the interactive WebLine (select, drag
                 * body, drag endpoints); rect/circle shapes and markers use a
                 * react-rnd overlay (drag + resize). The overlay div has
                 * pointer-events:none so empty-canvas taps still reach the
                 * responder system; each child re-enables pointer events.
                 * Native: keep the hand-rolled ShapeView + Pin renderers so the
                 * app still builds without react-rnd's DOM layer.
                 */}
                {Platform.OS === "web" ? (
                  <>
                    {/* react-rnd overlay (web only). Only renders once measured. */}
                    {W > 0 && H > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          pointerEvents: "none",
                        }}
                      >
                        {/* Interactive lines — select, drag body, drag endpoints.
                            Rendered first so they sit beneath rect/circle/markers. */}
                        {shapes
                          .filter((s) => s.type === "line")
                          .map((s) => (
                            <WebLine
                              key={s._id}
                              shape={s}
                              selected={s._id === selectedShapeId}
                              W={W}
                              H={H}
                              onSelect={() => selectShape(s._id)}
                              onUpdate={(patch) => opPatchShape(s._id, patch)}
                              clientToNorm={clientToNorm}
                            />
                          ))}

                        {/* Live preview of the line being drawn. `draftGeo` is
                            null before measurement or on a non-finite coord, so
                            no NaN ever reaches left/top/width. */}
                        {draftGeo ? (
                          <div
                            style={{
                              position: "absolute",
                              left: draftGeo.x1,
                              top: draftGeo.y1,
                              width: draftGeo.length,
                              height: 3,
                              backgroundColor: shapeHex(shapeColor),
                              opacity: 0.5,
                              borderRadius: 2,
                              transform: `rotateZ(${draftGeo.angleDeg}deg)`,
                              transformOrigin: "left center",
                              pointerEvents: "none",
                            }}
                          />
                        ) : null}

                        {/* Rect/circle shapes — drag + corner-resize. */}
                        {shapes
                          .filter((s) => s.type === "rect" || s.type === "circle")
                          .map((s) => (
                            <WebShapeRnd
                              key={s._id}
                              shape={s}
                              selected={s._id === selectedShapeId}
                              W={W}
                              H={H}
                              onSelect={() => selectShape(s._id)}
                              onDragStop={(x, y) =>
                                opPatchShape(s._id, {
                                  x: clamp01(x / W),
                                  y: clamp01(y / H),
                                })
                              }
                              onResizeStop={(w, h, x, y) =>
                                opPatchShape(s._id, {
                                  w: clamp01(w / W) || DEFAULT_SHAPE_SIZE,
                                  h: clamp01(h / H) || DEFAULT_SHAPE_SIZE,
                                  x: clamp01(x / W),
                                  y: clamp01(y / H),
                                })
                              }
                            />
                          ))}

                        {/* Marker pins — drag only. */}
                        {markers.map((m) => (
                          <WebMarkerRnd
                            key={m._id}
                            marker={m}
                            selected={m._id === selectedId}
                            W={W}
                            H={H}
                            onSelect={() => selectMarker(m._id)}
                            onDragStop={(x, y) =>
                              opPatchMarker(m._id, {
                                x: clamp01((x + MARKER_RND_OFFSET) / W),
                                y: clamp01((y + MARKER_RND_OFFSET) / H),
                              })
                            }
                          />
                        ))}
                      </div>
                    ) : null}

                    {/* Overlay layer (supplies / volunteers) — a parallel
                        pointer-events:none overlay so its chips coexist with
                        shapes & markers without joining the selection. Each
                        placed chip drags freely; the "×" returns it to its
                        tray. Only the enabled layers render. */}
                    {W > 0 && H > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          pointerEvents: "none",
                        }}
                      >
                        {placements
                          .filter((p) =>
                            p.kind === "supply" ? showSupplies : showVolunteers,
                          )
                          .map((p) => {
                            const supply =
                              p.kind === "supply"
                                ? supplyItems.find((s) => s.refId === p.refId) ??
                                  null
                                : null;
                            const volunteer =
                              p.kind === "volunteer"
                                ? volunteerItems.find(
                                    (v) => v.refId === p.refId,
                                  ) ?? null
                                : null;
                            return (
                              <WebPlacementCircle
                                key={p._id}
                                placement={p}
                                supply={supply}
                                volunteer={volunteer}
                                W={W}
                                H={H}
                                onDragStop={(x, y) =>
                                  void placeOrMove({
                                    scope: apiScope,
                                    kind: p.kind,
                                    refId: p.refId,
                                    x: clamp01(x / W),
                                    y: clamp01(y / H),
                                  })
                                }
                                onOpenDetail={() =>
                                  setDetailPlacement(
                                    p.kind === "supply"
                                      ? {
                                          placement: p,
                                          kind: "supply",
                                          item: supply,
                                        }
                                      : {
                                          placement: p,
                                          kind: "volunteer",
                                          item: volunteer,
                                        },
                                  )
                                }
                                onSplit={() =>
                                  void splitSupplyPlacement({
                                    placementId: p._id as any,
                                  })
                                }
                              />
                            );
                          })}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* Shapes layer — rendered BENEATH the pins. */}
                    {shapes.map((s) => (
                      <EditorShape
                        key={s._id}
                        shape={s}
                        selected={s._id === selectedShapeId}
                        containerSize={containerRect}
                        onPress={() => {
                          if (mode !== "select") return;
                          selectShape(s._id);
                        }}
                      />
                    ))}

                    {/* Marker pins — on top. */}
                    {markers.map((m) => (
                      <Pin
                        key={m._id}
                        marker={m}
                        selected={m._id === selectedId}
                        toNorm={eventToNorm}
                        onPress={() => {
                          if (mode !== "select") return;
                          selectMarker(m._id);
                        }}
                        onMove={(x, y) => {
                          opPatchMarker(m._id, { x, y });
                        }}
                      />
                    ))}
                  </>
                )}

                {/*
                 * Canva-style floating contextual bar — top-center of the
                 * canvas, shown only while something is selected. Replaces the
                 * old side-panel editors.
                 */}
                {selectedShape ? (
                  <ContextualBar
                    color={selectedShape.color ?? DEFAULT_SHAPE_COLOR}
                    label={selectedShape.label ?? ""}
                    onColor={(color) =>
                      opPatchShape(selectedShape._id, { color })
                    }
                    onLabel={(label) =>
                      opPatchShape(selectedShape._id, { label })
                    }
                    onDelete={() => {
                      opDeleteShape(selectedShape._id);
                      setSelectedShapeId(null);
                    }}
                    onClose={() => setSelectedShapeId(null)}
                  />
                ) : selected ? (
                  <ContextualBar
                    color={selected.color ?? DEFAULT_MARKER_COLOR}
                    label={selected.label ?? ""}
                    onColor={(color) => opPatchMarker(selected._id, { color })}
                    onLabel={(label) => opPatchMarker(selected._id, { label })}
                    onDelete={() => {
                      opDeleteMarker(selected._id);
                      setSelectedId(null);
                    }}
                    onClose={() => setSelectedId(null)}
                  />
                ) : null}
              </View>
          </View>
        </View>
  );

  // Read-only detail panel for a tapped placed circle — shared by both layouts.
  const detailModal = (
    <PlacementDetailModal
      detail={detailPlacement}
      onClose={() => setDetailPlacement(null)}
      onRemove={() => {
        if (detailPlacement) {
          void removePlacement({
            placementId: detailPlacement.placement._id as any,
          });
        }
        setDetailPlacement(null);
      }}
    />
  );

  // Embedded inside the event screen — no page chrome, just the canvas.
  if (embedded) {
    return (
      <>
        {canvas}
        {detailModal}
      </>
    );
  }

  // Standalone route — full page chrome (header, back breadcrumb).
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Site map" }} />
      <Screen>
        {/* Left-aligned back breadcrumb (matches the rest of the app). */}
        <Pressable
          onPress={() => router.back()}
          className="mb-4 flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Icon name="arrow-left" size={15} color={colors.muted} />
          <Text className="text-sm font-medium text-muted">Back</Text>
        </Pressable>
        <PageHeader
          eyebrow={eventName}
          title="Site map"
          subtitle="Sketch your venue with boxes, circles, and lines, then drop labelled pins so the team knows where everything goes."
        />
        {canvas}
      </Screen>
      {detailModal}
    </>
  );
}
