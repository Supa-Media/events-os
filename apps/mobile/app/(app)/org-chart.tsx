/**
 * ORG CHART — a full-bleed, Figma-like canvas over the org's seat taxonomy
 * (`seats.ts`), plus its INTERACTION layer: two-party proposals, superuser
 * direct assignment, and (for an `org.editChart` holder / superuser)
 * structure editing.
 *
 * LAYOUT (this file + `OrgChartCanvas`/`SeatOverlayPanel`/`OrgChartToolbar`):
 * the tree fills the entire content area — no card border/box — pannable
 * (click-drag / two-finger scroll / native drag) and zoomable (ctrl+wheel /
 * pinch), with a slim floating toolbar docked over the top and the seat
 * detail panel sliding in as an overlay from the right when a seat is
 * selected. See each of those files' own doc comments for the platform
 * gesture split. The READ-ONLY rendering itself (`OrgTree`/`SeatBox`) and
 * every interaction (`SeatDetailPanel`/`SeatActions`/`ProposalsInbox`/
 * `StructureEditor`) are UNCHANGED from the shipped tab — only the container
 * they sit in was rebuilt.
 *
 * PANEL-VS-CHROME OVERLAP (PR #206 review point 1): `SeatOverlayPanel` is a
 * full-height strip pinned to the right edge, and both the toolbar's
 * right-aligned controls ("Edit structure", the proposals indicator) and the
 * canvas's corner `CanvasControls` (zoom/Fit) would otherwise land underneath
 * it whenever a seat is selected — plain DOM/RN stacking order (not z-index
 * alone) put the panel, rendered last, on top of and covering both. Rather
 * than fight that with z-index, both are geometrically kept OUT of the
 * panel's strip while it's open: the toolbar wrapper's `right` is inset by
 * `panelWidth` (see below) so the whole card sits to the panel's left with no
 * overlap, and `OrgChartCanvas`'s `controlsRightInset` prop shifts
 * `CanvasControls` the same amount so it clears the panel too.
 *
 * Org-transparent: any signed-in member may view it (mirrors the backend's
 * own "the whole team may see the whole org" stance — see `seats.ts`'s file
 * doc), so the nav entry is ungated, same as Academy.
 *
 * Fetches `seats.chart({})` — the FULL payload — exactly ONCE. Every scope
 * pill (Central / a chapter / Full tree) is then built CLIENT-SIDE from that
 * same result (`treeUtils.buildChartTree` / `buildFullTree`), so switching
 * scope is instant and never re-queries. Tapping a seat box fetches that one
 * seat's `seats.seatDetail` (duties/capabilities/holders) for the panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { colors } from "../../lib/theme";
import { EditChartCapabilityProbe } from "../../components/orgchart/CapabilityProbe";
import { OrgChartCanvas } from "../../components/orgchart/OrgChartCanvas";
import { OrgChartToolbar } from "../../components/orgchart/OrgChartToolbar";
import { OrgTree } from "../../components/orgchart/OrgTree";
import { SeatOverlayPanel } from "../../components/orgchart/SeatOverlayPanel";
import type { ScopeChoice } from "../../components/orgchart/ScopePills";
import { SeatDetailPanel } from "../../components/orgchart/SeatDetailPanel";
import { AddSeatModal, StructureEditBanner } from "../../components/orgchart/StructureEditor";
import {
  buildChartTree,
  buildFullTree,
  computeReportsTo,
  findNodeByKey,
  subtreeSlugs,
  type ChartBuild,
  type FullChart,
  type TreeNode,
} from "../../components/orgchart/treeUtils";

/** Overlay panel width — clamped to the window width on narrow screens so it
 *  reads as a near-full-width drawer on phones instead of overflowing. */
const PANEL_WIDTH = 380;
const PANEL_MARGIN = 24;

export default function OrgChartScreen() {
  const chart = useQuery(api.seats.chart, {}) as FullChart | undefined;
  const me = useQuery(api.profiles.me);
  const isSuperuser = me?.isSuperuser === true;
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(PANEL_WIDTH, Math.max(240, width - PANEL_MARGIN));

  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("central");
  // Only the selection KEY lives in state — the actual node is re-resolved
  // from the live `chart` query on every render (`findNodeByKey` below), so
  // a holder change elsewhere while the panel is open shows up here too
  // instead of the panel showing a stale snapshot captured at click time.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [addSeatTarget, setAddSeatTarget] = useState<TreeNode | null>(null);

  // ── "Can this caller edit the chart's STRUCTURE?" ──────────────────────
  // `seats.chart` doesn't carry per-seat capabilities (only `seatDetail`
  // does — see `CapabilityProbe.tsx`'s doc comment), so this mounts one
  // invisible `seatDetail` probe per seat the caller holds
  // (`mySeatAssignments`, almost always 0-2 rows) and aggregates whether ANY
  // of them carries `org.editChart`. Superuser always passes (the same
  // backstop `requireChartEditor` grants server-side) — skip probing then.
  //
  // `editCapFlags` must mirror the LIVE probe set, not just accumulate: a
  // probe reports `undefined` on unmount (its seat assignment disappeared —
  // reassigned away, direct-assigned over), and that DELETES the key here
  // rather than leaving a stale `true` behind. Without this, "Edit
  // structure" and every edit affordance would keep showing for a caller who
  // no longer holds `org.editChart` on anything, only to have every mutation
  // rejected server-side.
  const mySeatAssignments = useQuery(api.seats.mySeatAssignments, isSuperuser ? "skip" : {});
  const [editCapFlags, setEditCapFlags] = useState<Record<string, boolean>>({});
  const reportEditCap = useCallback((key: string, hasEditChart: boolean | undefined) => {
    setEditCapFlags((prev) => {
      if (hasEditChart === undefined) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev[key] === hasEditChart ? prev : { ...prev, [key]: hasEditChart };
    });
  }, []);
  const canEditStructure = isSuperuser || Object.values(editCapFlags).some(Boolean);

  // Switching scope pills rebuilds an entirely different tree — a box
  // selected in the old one may not even exist in the new one (and even
  // when it does, showing its stale panel while the tree re-renders reads as
  // a bug). Clear the selection on every scope change.
  const handleScopeChange = (next: ScopeChoice) => {
    setScopeChoice(next);
    setSelectedKey(null);
  };

  const { root, orphans }: ChartBuild = useMemo(() => {
    if (!chart) return { root: null, orphans: [] };
    if (scopeChoice === "central") return buildChartTree(chart.central, "central");
    if (scopeChoice === "full") return buildFullTree(chart);
    const chapter = chart.chapters.find((c) => c.chapterId === scopeChoice);
    return chapter ? buildChartTree(chapter.seats, chapter.chapterId) : { root: null, orphans: [] };
  }, [chart, scopeChoice]);

  const selected = useMemo(
    () => findNodeByKey(root, orphans, selectedKey),
    [root, orphans, selectedKey],
  );

  // The overlay panel keeps rendering its LAST non-null selection while it
  // slides shut (`SeatOverlayPanel` only hides once the animation finishes)
  // — otherwise it'd flash "Select a seat" mid-close instead of just fading
  // out with its last content. `panelOpen` (not `selected`) is the panel's
  // source of truth for visibility.
  const lastSelectedRef = useRef<TreeNode | null>(null);
  if (selected) lastSelectedRef.current = selected;
  const panelOpen = selected !== null;
  const displaySelected = selected ?? lastSelectedRef.current;

  const detail = useQuery(
    api.seats.seatDetail,
    displaySelected ? { defId: displaySelected.seat.defId, scope: displaySelected.scope } : "skip",
  );

  const reportsTo = useMemo(() => {
    if (!chart || !displaySelected) return null;
    return computeReportsTo(displaySelected.seat, displaySelected.scope, chart);
  }, [chart, displaySelected]);

  const scopeName = useMemo(() => {
    if (!chart || !displaySelected) return "";
    if (displaySelected.scope === "central") return "Central";
    return chart.chapters.find((c) => c.chapterId === displaySelected.scope)?.chapterName ?? "Chapter";
  }, [chart, displaySelected]);

  // Every OTHER seat in the SAME chart as the selected seat — reparent
  // candidates for the structure editor's "Move" picker. The chapter chart
  // is one shared definition stamped onto every chapter (see `seats.ts`'s
  // file doc), so ANY chapter's seat list enumerates the same slugs/titles —
  // this uses the selected seat's OWN chapter when it's chapter-scoped.
  //
  // Excludes the selected seat's own subtree (itself + every descendant):
  // reparenting a seat under one of its own descendants is always a cycle —
  // the backend correctly rejects it, but there's no reason to present those
  // as clickable options and force the editor into a guaranteed error.
  const chartSeatOptions = useMemo(() => {
    if (!chart || !displaySelected) return [];
    const seats =
      displaySelected.scope === "central"
        ? chart.central
        : (chart.chapters.find((c) => c.chapterId === displaySelected.scope)?.seats ?? []);
    const excluded = subtreeSlugs(seats, displaySelected.seat.slug);
    return seats
      .filter((s) => !s.derived && !excluded.has(s.slug))
      .map((s) => ({ slug: s.slug, title: s.title }));
  }, [chart, displaySelected]);

  const closePanel = useCallback(() => setSelectedKey(null), []);

  // "You: <name> — <seat titles>" toolbar context line.
  const meName = me?.profile?.name ?? null;
  const mySeatTitles = useMemo(() => (mySeatAssignments ?? []).map((a) => a.title), [mySeatAssignments]);

  // Re-triggers the canvas's auto-fit once the chart first loads, and again
  // on every scope switch (a different scope is a differently-shaped,
  // differently-sized tree) — see `OrgChartCanvas`'s `fitToken` doc.
  const fitToken = `${scopeChoice}:${root ? root.key : "loading"}`;

  // Close the AddSeatModal's target if the underlying seat vanished out from
  // under it (e.g. a concurrent structure edit removed it) — defensive, same
  // spirit as `onSeatRemoved` below.
  useEffect(() => {
    if (addSeatTarget && !findNodeByKey(root, orphans, addSeatTarget.key)) {
      setAddSeatTarget(null);
    }
  }, [addSeatTarget, root, orphans]);

  if (chart === undefined) {
    return (
      <View className="flex-1 items-center justify-center bg-surface">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
        {root ? (
          <OrgChartCanvas
            onBackgroundPress={closePanel}
            fitToken={fitToken}
            controlsRightInset={panelOpen ? panelWidth : 0}
          >
            <OrgTree
              root={root}
              orphans={orphans}
              selectedKey={selected?.key ?? null}
              onSelect={(node) => setSelectedKey(node.key)}
              onAddSeat={editMode ? (node) => setAddSeatTarget(node) : undefined}
            />
          </OrgChartCanvas>
        ) : (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-sm text-muted">The org chart hasn&apos;t been seeded yet.</Text>
          </View>
        )}
      </View>

      {/* Floating chrome — toolbar + (in edit mode) the structure-edit
          banner — docked over the top of the canvas. `box-none` lets clicks
          on the empty space around them reach the canvas underneath.
          While the seat panel is open, its right edge is inset by
          `panelWidth` so the WHOLE toolbar card (title, scope pills, and
          crucially the "Edit structure"/proposals buttons on its right edge)
          sits entirely to the left of the panel's strip — no overlap at all,
          rather than relying on z-index to win a fight over the same pixels.
          See PR #206 review point 1. */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, left: 0, right: panelOpen ? panelWidth : 0 }}
      >
        <OrgChartToolbar
          chart={chart}
          scopeChoice={scopeChoice}
          onScopeChange={handleScopeChange}
          canEditStructure={canEditStructure}
          editMode={editMode}
          onToggleEditMode={() => setEditMode((e) => !e)}
          meName={meName}
          mySeatTitles={mySeatTitles}
        />
        {editMode ? (
          <View className="mx-3">
            <StructureEditBanner />
          </View>
        ) : null}
      </View>

      {!isSuperuser
        ? (mySeatAssignments ?? []).map((a) => (
            <EditChartCapabilityProbe
              key={a.assignmentId}
              defId={a.seatDefId}
              scope={a.scope}
              onResult={reportEditCap}
            />
          ))
        : null}

      <SeatOverlayPanel open={panelOpen} width={panelWidth} onClose={closePanel}>
        <SeatDetailPanel
          selected={displaySelected}
          scopeName={scopeName}
          detail={detail}
          reportsTo={reportsTo}
          isSuperuser={isSuperuser}
          editMode={editMode}
          chartSeatOptions={chartSeatOptions}
          onSeatRemoved={closePanel}
        />
      </SeatOverlayPanel>

      <AddSeatModal
        visible={!!addSeatTarget}
        chart={addSeatTarget ? (addSeatTarget.scope === "central" ? "central" : "chapter") : null}
        parentSlug={addSeatTarget?.seat.slug ?? null}
        parentTitle={addSeatTarget?.seat.title ?? null}
        onClose={() => setAddSeatTarget(null)}
      />
    </View>
  );
}
