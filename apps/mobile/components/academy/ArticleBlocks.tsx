import { View, Text, ScrollView } from "react-native";
import type { AcademyBlock } from "@events-os/shared";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { Inline } from "./Inline";
import { TryCard } from "./TryCard";
import { TryStatus } from "./TryStatus";
import { TryOffset } from "./TryOffset";
import { TryChain } from "./TryChain";
import { TryReady } from "./TryReady";
import { Reveal } from "./Reveal";
import { AgentDemo } from "./AgentDemo";

/**
 * ARTICLE BLOCKS — renders an Academy article's typed content blocks as a
 * designed page: prose with inline emphasis, story callouts, principle
 * cards, cadence tables, in-app tips, and the interactive practice widgets
 * (status chips, the offset sandbox, the chain explorer, the mark-ready
 * simulator, scenario reveals, the assistant demo). Interactive blocks hold
 * throwaway local state only — nothing here writes to the backend.
 */
export function ArticleBlocks({ blocks }: { blocks: AcademyBlock[] }) {
  return (
    <View className="gap-3.5">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </View>
  );
}

function Block({ block }: { block: AcademyBlock }) {
  switch (block.kind) {
    case "p":
      return (
        <Text className="text-base leading-6 text-ink">
          <Inline text={block.text} />
        </Text>
      );
    case "heading":
      return (
        <Text className="mt-2.5 font-display text-lg text-ink">
          {block.text}
        </Text>
      );
    case "bullets":
      return (
        <View className="gap-2">
          {block.items.map((item, i) => (
            <View key={i} className="flex-row items-start gap-2.5 pl-0.5">
              <View className="mt-2.5 h-1.5 w-1.5 rounded-pill bg-accent" />
              <Text className="flex-1 text-base leading-6 text-ink">
                <Inline text={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "story":
      return <Story title={block.title} text={block.text} />;
    case "rule":
      return <Rule title={block.title} text={block.text} />;
    case "table":
      return <BlockTable headers={block.headers} rows={block.rows} />;
    case "tip":
      return <Tip text={block.text} />;
    case "try_status":
      return (
        <TryCard eyebrow="Try it" icon="mouse-pointer">
          <TryStatus
            title={block.title}
            options={block.options}
            terminal={block.terminal}
            caption={block.caption}
          />
        </TryCard>
      );
    case "try_offset":
      return (
        <TryCard eyebrow="Try it" icon="mouse-pointer">
          <TryOffset eventDateLabel={block.eventDateLabel} />
        </TryCard>
      );
    case "try_chain":
      return (
        <TryCard eyebrow="Try it" icon="mouse-pointer">
          <TryChain />
        </TryCard>
      );
    case "try_ready":
      return (
        <TryCard eyebrow="Try it" icon="mouse-pointer">
          <TryReady criteria={block.criteria} />
        </TryCard>
      );
    case "reveal":
      return (
        <TryCard eyebrow="What would you do?" icon="help-circle">
          <Reveal prompt={block.prompt} answer={block.answer} />
        </TryCard>
      );
    case "agent_demo":
      return (
        <TryCard eyebrow="Watch it work" icon="sparkles">
          <AgentDemo exchanges={block.exchanges} />
        </TryCard>
      );
  }
}

// ── Callouts ──────────────────────────────────────────────────────────────────

/** "From the field" pull-quote — warm background, left accent bar. */
function Story({ title, text }: { title: string; text: string }) {
  return (
    <View
      className="rounded-lg bg-warn-bg p-4"
      style={{ borderLeftWidth: 3, borderLeftColor: colors.warn }}
    >
      <View className="flex-row items-center gap-2">
        <Icon name="book-open" size={13} color={colors.warn} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-warn">
          From the field · {title}
        </Text>
      </View>
      <Text className="mt-2 text-base italic leading-6 text-ink">
        <Inline text={text} />
      </Text>
    </View>
  );
}

/** Key-principle card — the rule the section hangs on. */
function Rule({ title, text }: { title: string; text: string }) {
  return (
    <View className="rounded-lg border border-accent-soft bg-accent-soft p-4">
      <View className="flex-row items-start gap-2.5">
        <View className="mt-0.5">
          <Icon name="zap" size={15} color={colors.accent} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-bold text-ink">{title}</Text>
          <Text className="mt-1 text-sm leading-5 text-ink">
            <Inline text={text} />
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Compact "In the app · …" pointer strip. */
function Tip({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-2.5 rounded-md bg-sunken px-3 py-2.5">
      <View className="mt-0.5">
        <Icon name="smartphone" size={13} color={colors.muted} />
      </View>
      <Text className="flex-1 text-sm leading-5 text-muted">
        <Text className="font-bold">In the app</Text> · <Inline text={text} />
      </Text>
    </View>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

/**
 * Content-sized column widths so the header row and every data row align
 * (each row is its own flex container). Long cells wrap inside their column;
 * the whole table scrolls horizontally when it outgrows the screen — same
 * pattern as the People grid.
 */
function columnWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((h, c) => {
    const longest = Math.max(
      h.length,
      ...rows.map((r) => (r[c] ?? "").length),
    );
    // ~6.5px per character at text-sm, clamped so short columns stay tight
    // and long prose wraps instead of stretching forever.
    return Math.round(Math.min(300, Math.max(104, longest * 6.5 + 26)));
  });
}

function BlockTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  const widths = columnWidths(headers, rows);
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%" }}>
          <View className="flex-row border-b border-border bg-sunken">
            {headers.map((h, c) => (
              <View key={c} style={{ width: widths[c] }} className="px-3 py-2">
                <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                  {h}
                </Text>
              </View>
            ))}
          </View>
          {rows.map((row, r) => (
            <View
              key={r}
              className={`flex-row ${
                r < rows.length - 1 ? "border-b border-border" : ""
              } ${r % 2 === 1 ? "bg-sunken/40" : ""}`}
            >
              {headers.map((_h, c) => (
                <View
                  key={c}
                  style={{ width: widths[c] }}
                  className="px-3 py-2.5"
                >
                  <Text className="text-sm leading-5 text-ink">
                    <Inline text={row[c] ?? ""} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
