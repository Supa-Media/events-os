import { View, Text } from "react-native";
import { colors } from "../../lib/theme";
import { Inline } from "./Inline";

type TreeNode = {
  label: string;
  depth: number;
  highlight?: "self" | "manager" | "reports";
};

// Per-depth left indent (px). Clamped to the last entry for deeper nodes so a
// stray large depth can't push a row off the right edge on narrow screens.
const INDENT = [0, 18, 36, 54, 72, 90];

function indentFor(depth: number): number {
  const d = Math.max(0, Math.min(depth, INDENT.length - 1));
  return INDENT[d];
}

/**
 * A tree / org-chart diagram — an indented list of nodes. Presentational only.
 * Each node indents by its `depth`; a thin connector rail sits to the left of
 * indented rows. `highlight` gives the learner's own seat (`self`), their
 * manager, and their reports distinct treatments. Labels wrap on narrow widths
 * rather than overflow.
 */
export function Tree({
  caption,
  nodes,
}: {
  caption?: string;
  nodes: TreeNode[];
}) {
  return (
    <View className="rounded-lg border border-border bg-raised p-3">
      <View className="gap-1.5">
        {nodes.map((node, i) => (
          <View
            key={i}
            className="flex-row items-center"
            style={{ paddingLeft: indentFor(node.depth) }}
          >
            {node.depth > 0 ? (
              <View
                className="mr-2 self-stretch"
                style={{ borderLeftWidth: 1, borderLeftColor: colors.border }}
              />
            ) : null}
            <TreeRow label={node.label} highlight={node.highlight} />
          </View>
        ))}
      </View>
      {caption ? (
        <Text className="mt-2.5 text-xs leading-4 text-faint">
          <Inline text={caption} />
        </Text>
      ) : null}
    </View>
  );
}

function TreeRow({
  label,
  highlight,
}: {
  label: string;
  highlight?: TreeNode["highlight"];
}) {
  if (highlight === "self") {
    return (
      <View className="shrink self-start rounded-md border border-accent-soft bg-accent-soft px-2.5 py-1.5">
        <Text className="text-sm font-bold leading-5 text-accent">
          <Inline text={label} />
        </Text>
      </View>
    );
  }
  if (highlight === "manager") {
    return (
      <View className="shrink self-start rounded-md border border-border-strong px-2.5 py-1.5">
        <Text className="text-sm font-semibold leading-5 text-ink">
          <Inline text={label} />
        </Text>
      </View>
    );
  }
  if (highlight === "reports") {
    return (
      <View className="shrink self-start rounded-md bg-sunken px-2.5 py-1.5">
        <Text className="text-sm leading-5 text-muted">
          <Inline text={label} />
        </Text>
      </View>
    );
  }
  return (
    <Text className="shrink py-1.5 text-sm leading-5 text-ink">
      <Inline text={label} />
    </Text>
  );
}
