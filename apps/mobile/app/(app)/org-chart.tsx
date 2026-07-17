/**
 * ORG CHART — read-only tree view of the org's seat taxonomy (`seats.ts`).
 * Org-transparent: any signed-in member may view it (mirrors the backend's
 * own "the whole team may see the whole org" stance — see `seats.ts`'s file
 * doc), so the nav entry is ungated, same as Academy.
 *
 * Fetches `seats.chart({})` — the FULL payload — exactly ONCE. Every scope
 * pill (Central / a chapter / Full tree) is then built CLIENT-SIDE from that
 * same result (`treeUtils.buildChartTree` / `buildFullTree`), so switching
 * scope is instant and never re-queries. Tapping a seat box fetches that
 * one seat's `seats.seatDetail` (duties/capabilities/holders) for the panel.
 *
 * Read-only: no assignment/editing UI here — that's a later PR (WP: seat
 * assignment mutations land in a separate stacked branch).
 */
import { useMemo, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { FULL_WIDTH, Narrow, Screen } from "../../components/ui";
import { OrgTree } from "../../components/orgchart/OrgTree";
import { ScopePills, type ScopeChoice } from "../../components/orgchart/ScopePills";
import { SeatDetailPanel } from "../../components/orgchart/SeatDetailPanel";
import {
  buildChartTree,
  buildFullTree,
  computeReportsTo,
  type FullChart,
  type TreeNode,
} from "../../components/orgchart/treeUtils";

/** Panel-beside-tree breakpoint — wider than the shell's own 760px desktop
 *  cutoff since the tree wants real horizontal room before splitting off a
 *  side panel; below it the panel drops beneath the tree, full-width. */
const WIDE = 900;

export default function OrgChartScreen() {
  const chart = useQuery(api.seats.chart, {}) as FullChart | undefined;
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("central");
  const [selected, setSelected] = useState<TreeNode | null>(null);

  // Switching scope pills rebuilds an entirely different tree — a box
  // selected in the old one may not even exist in the new one (and even
  // when it does, showing its stale panel while the tree re-renders reads as
  // a bug). Clear the selection on every scope change.
  const handleScopeChange = (next: ScopeChoice) => {
    setScopeChoice(next);
    setSelected(null);
  };

  const detail = useQuery(
    api.seats.seatDetail,
    selected ? { defId: selected.seat.defId, scope: selected.scope } : "skip",
  );

  const root = useMemo(() => {
    if (!chart) return null;
    if (scopeChoice === "central") return buildChartTree(chart.central, "central");
    if (scopeChoice === "full") return buildFullTree(chart);
    const chapter = chart.chapters.find((c) => c.chapterId === scopeChoice);
    return chapter ? buildChartTree(chapter.seats, chapter.chapterId) : null;
  }, [chart, scopeChoice]);

  const reportsTo = useMemo(() => {
    if (!chart || !selected) return null;
    return computeReportsTo(selected.seat, selected.scope, chart);
  }, [chart, selected]);

  const scopeName = useMemo(() => {
    if (!chart || !selected) return "";
    if (selected.scope === "central") return "Central";
    return chart.chapters.find((c) => c.chapterId === selected.scope)?.chapterName ?? "Chapter";
  }, [chart, selected]);

  if (chart === undefined) {
    return <Screen loading />;
  }

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <Narrow>
        <Text className="mb-1 font-display text-2xl text-ink">Org Chart</Text>
        <Text className="mb-4 text-sm text-muted">
          Who holds which seat, their duties, and what they can do — across the
          org and every chapter. Read-only for now.
        </Text>
        <ScopePills chart={chart} value={scopeChoice} onChange={handleScopeChange} />
      </Narrow>

      {root ? (
        <View style={{ flexDirection: wide ? "row" : "column", gap: 20, alignItems: "flex-start" }}>
          <View className="flex-1 overflow-hidden rounded-lg border border-border bg-raised shadow-card">
            <OrgTree
              root={root}
              selectedKey={selected?.key ?? null}
              onSelect={setSelected}
            />
          </View>
          <View style={{ width: wide ? 340 : "100%" }}>
            <SeatDetailPanel
              selected={selected}
              scopeName={scopeName}
              detail={detail}
              reportsTo={reportsTo}
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
    </Screen>
  );
}
