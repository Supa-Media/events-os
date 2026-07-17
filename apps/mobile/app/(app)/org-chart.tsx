/**
 * ORG CHART — tree view of the org's seat taxonomy (`seats.ts`), plus its
 * INTERACTION layer: two-party proposals, superuser direct assignment, and
 * (for an `org.editChart` holder / superuser) structure editing. The
 * read-only rendering ITSELF is unchanged from the shipped tab — every
 * addition here is either an opt-in action button on the seat panel or a
 * section that renders nothing when there's nothing to show.
 *
 * Org-transparent: any signed-in member may view it (mirrors the backend's
 * own "the whole team may see the whole org" stance — see `seats.ts`'s file
 * doc), so the nav entry is ungated, same as Academy.
 *
 * Fetches `seats.chart({})` — the FULL payload — exactly ONCE. Every scope
 * pill (Central / a chapter / Full tree) is then built CLIENT-SIDE from that
 * same result (`treeUtils.buildChartTree` / `buildFullTree`), so switching
 * scope is instant and never re-queries. Tapping a seat box fetches that
 * one seat's `seats.seatDetail` (duties/capabilities/holders) for the panel.
 */
import { useCallback, useMemo, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, FULL_WIDTH, Narrow, Screen } from "../../components/ui";
import { EditChartCapabilityProbe } from "../../components/orgchart/CapabilityProbe";
import { OrgTree } from "../../components/orgchart/OrgTree";
import { ProposalsInbox } from "../../components/orgchart/ProposalsInbox";
import { ScopePills, type ScopeChoice } from "../../components/orgchart/ScopePills";
import { SeatDetailPanel } from "../../components/orgchart/SeatDetailPanel";
import { AddSeatModal, StructureEditBanner } from "../../components/orgchart/StructureEditor";
import {
  buildChartTree,
  buildFullTree,
  computeReportsTo,
  findNodeByKey,
  type ChartBuild,
  type FullChart,
  type TreeNode,
} from "../../components/orgchart/treeUtils";

/** Panel-beside-tree breakpoint — wider than the shell's own 760px desktop
 *  cutoff since the tree wants real horizontal room before splitting off a
 *  side panel; below it the panel drops beneath the tree, full-width. */
const WIDE = 900;

export default function OrgChartScreen() {
  const chart = useQuery(api.seats.chart, {}) as FullChart | undefined;
  const me = useQuery(api.profiles.me);
  const isSuperuser = me?.isSuperuser === true;
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

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
  const mySeatAssignments = useQuery(api.seats.mySeatAssignments, isSuperuser ? "skip" : {});
  const [editCapFlags, setEditCapFlags] = useState<Record<string, boolean>>({});
  const reportEditCap = useCallback((key: string, hasEditChart: boolean) => {
    setEditCapFlags((prev) => (prev[key] === hasEditChart ? prev : { ...prev, [key]: hasEditChart }));
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

  const detail = useQuery(
    api.seats.seatDetail,
    selected ? { defId: selected.seat.defId, scope: selected.scope } : "skip",
  );

  const reportsTo = useMemo(() => {
    if (!chart || !selected) return null;
    return computeReportsTo(selected.seat, selected.scope, chart);
  }, [chart, selected]);

  const scopeName = useMemo(() => {
    if (!chart || !selected) return "";
    if (selected.scope === "central") return "Central";
    return chart.chapters.find((c) => c.chapterId === selected.scope)?.chapterName ?? "Chapter";
  }, [chart, selected]);

  // Every OTHER seat in the SAME chart as the selected seat — reparent
  // candidates for the structure editor's "Move" picker. The chapter chart
  // is one shared definition stamped onto every chapter (see `seats.ts`'s
  // file doc), so ANY chapter's seat list enumerates the same slugs/titles —
  // this uses the selected seat's OWN chapter when it's chapter-scoped.
  const chartSeatOptions = useMemo(() => {
    if (!chart || !selected) return [];
    const seats =
      selected.scope === "central"
        ? chart.central
        : (chart.chapters.find((c) => c.chapterId === selected.scope)?.seats ?? []);
    return seats.filter((s) => !s.derived).map((s) => ({ slug: s.slug, title: s.title }));
  }, [chart, selected]);

  if (chart === undefined) {
    return <Screen loading />;
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <View className="mb-1 flex-row items-start justify-between gap-3">
          <Text className="font-display text-2xl text-ink">Org Chart</Text>
          {canEditStructure ? (
            <Button
              title={editMode ? "Done editing" : "Edit structure"}
              variant={editMode ? "primary" : "secondary"}
              size="sm"
              icon={editMode ? "check" : "edit-2"}
              onPress={() => setEditMode((e) => !e)}
            />
          ) : null}
        </View>
        <Text className="mb-4 text-sm text-muted">
          Who holds which seat, their duties, and what they can do — across the
          org and every chapter.
        </Text>
        {editMode ? <StructureEditBanner /> : null}
        <ProposalsInbox />
        <ScopePills chart={chart} value={scopeChoice} onChange={handleScopeChange} />
      </Narrow>

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

      {root ? (
        <View style={{ flexDirection: wide ? "row" : "column", gap: 20, alignItems: "flex-start" }}>
          <View className="flex-1 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
            <OrgTree
              root={root}
              orphans={orphans}
              selectedKey={selected?.key ?? null}
              onSelect={(node) => setSelectedKey(node.key)}
              onAddSeat={editMode ? (node) => setAddSeatTarget(node) : undefined}
            />
          </View>
          <View style={{ width: wide ? 340 : "100%" }}>
            <SeatDetailPanel
              selected={selected}
              scopeName={scopeName}
              detail={detail}
              reportsTo={reportsTo}
              isSuperuser={isSuperuser}
              editMode={editMode}
              chartSeatOptions={chartSeatOptions}
              onSeatRemoved={() => setSelectedKey(null)}
            />
          </View>
        </View>
      ) : (
        <Narrow>
          <Text className="text-sm text-muted">
            The org chart hasn&apos;t been seeded yet.
          </Text>
        </Narrow>
      )}

      <AddSeatModal
        visible={!!addSeatTarget}
        chart={addSeatTarget ? (addSeatTarget.scope === "central" ? "central" : "chapter") : null}
        parentSlug={addSeatTarget?.seat.slug ?? null}
        parentTitle={addSeatTarget?.seat.title ?? null}
        onClose={() => setAddSeatTarget(null)}
      />
    </Screen>
  );
}
