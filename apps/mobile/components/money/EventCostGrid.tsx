/**
 * EventCostGrid (phase 2 of "one money surface") — a database-style grid of
 * EVERY cost-bearing item on this event, not just the finance plan: Tasks /
 * Supplies / Comms costs, paid vendors (Crew & Duties), and budget lines
 * (WP-3.1), one row each. Source of truth stays in each row's OWN home
 * table — editing "Planned $" here writes straight back to that table's
 * existing mutation (`items.updateEventItem`, `engagements.update`, or
 * `budgetLines.updateLine`); this component never introduces a new ledger.
 * A row's chevron deep-links to its home surface for anything beyond a
 * cost/label tweak (`moneyViews.eventCostGrid` supplies `sourceLink`).
 *
 * "Add row": pick a Type, and it creates a REAL item of that type (a minimal
 * Task/Supply/Comms row, or a budget line via the caller's existing "Edit
 * plan" flow) — never a placeholder floating outside its home module. Adding
 * a VENDOR needs a person picker (an existing, heavier flow on Crew & Duties)
 * so its "+" just deep-links there rather than duplicating that picker here.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  HeaderCell,
  Icon,
  Row,
  SectionHeader,
  Select,
  Table,
  TableHeader,
} from "../ui";
import { colors } from "../../lib/theme";
import { alertError, alertInfo } from "../../lib/errors";

type GridData = FunctionReturnType<typeof api.moneyViews.eventCostGrid>;
type GridRow = GridData["rows"][number];

const ADD_TYPE_OPTIONS = [
  { value: "planning_doc", label: "Task" },
  { value: "supplies", label: "Supply" },
  { value: "comms", label: "Comms" },
  { value: "vendor", label: "Vendor (Crew & Duties)" },
];

function dollarsToCents(text: string): number | null {
  const dollars = parseFloat(text);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function EventCostGrid({ eventId }: { eventId: Id<"events"> }) {
  const router = useRouter();
  const data = useQuery(api.moneyViews.eventCostGrid, { eventId });
  const [addOpen, setAddOpen] = useState(false);

  if (data === undefined) {
    return (
      <View className="mt-4">
        <Text className="text-sm text-muted">Loading cost inventory…</Text>
      </View>
    );
  }
  if (data.isTraining) return null;

  const groups = new Map<string, GridRow[]>();
  for (const row of data.rows) {
    const bucket = groups.get(row.typeLabel);
    if (bucket) bucket.push(row);
    else groups.set(row.typeLabel, [row]);
  }

  function goTo(link: string) {
    router.push(link as never);
  }

  return (
    <View className="mt-6">
      <SectionHeader
        title="Cost inventory"
        count={data.rows.length}
        right={
          <Pressable
            onPress={() => setAddOpen((o) => !o)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Icon name={addOpen ? "x" : "plus"} size={14} color={colors.accent} />
            <Text className="text-sm font-medium text-accent">
              {addOpen ? "Close" : "Add"}
            </Text>
          </Pressable>
        }
      />
      <Text className="mb-3 -mt-2 text-xs text-muted">
        Everything on this event with a cost — Tasks, Supplies, Comms, paid
        vendors, and finance budget lines, in one place. Edits write straight
        back to each item's own home; the chevron opens it there.
      </Text>

      {addOpen ? <AddRow eventId={eventId} onDone={() => setAddOpen(false)} /> : null}

      {data.rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="No cost items yet"
          message="Tasks, supplies, comms, vendors, and budget lines with a cost will show up here."
        />
      ) : (
        [...groups.entries()].map(([typeLabel, rows]) => (
          <View key={typeLabel} className="mt-3">
            <Table>
              <TableHeader>
                {/* `typeLabel` is already the group's own display label
                    (a real module label, or "Vendors"/"Budget lines") — no
                    naive "+s" here (that's the bug that produced "Supplys"). */}
                <HeaderCell flex={3}>{typeLabel}</HeaderCell>
                <HeaderCell flex={2}>Status</HeaderCell>
                <HeaderCell width={110} align="right">
                  Planned
                </HeaderCell>
                <HeaderCell width={28}> </HeaderCell>
              </TableHeader>
              {rows.map((row, i) => (
                <GridRowView
                  key={row.id}
                  row={row}
                  last={i === rows.length - 1}
                  onOpen={row.sourceLink ? () => goTo(row.sourceLink!) : undefined}
                />
              ))}
            </Table>
          </View>
        ))
      )}

      {data.rows.length > 0 ? (
        <View className="mt-2 flex-row items-center justify-end gap-2 px-1">
          <Text className="text-xs text-muted">Total</Text>
          <Text className="text-sm font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(data.totalPlannedCents)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function GridRowView({
  row,
  last,
  onOpen,
}: {
  row: GridRow;
  last: boolean;
  onOpen?: () => void;
}) {
  return (
    <Row last={last}>
      <Cell flex={3}>
        <View className="flex-row items-center gap-1.5">
          {row.linked ? (
            <Icon name="link" size={12} color={colors.muted} />
          ) : null}
          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
            {row.label}
          </Text>
        </View>
        {row.possibleDuplicate ? (
          <View className="mt-0.5 flex-row items-center gap-1">
            <Icon name="alert-triangle" size={11} color={colors.warn} />
            <Text className="text-2xs text-warn">Possible duplicate</Text>
          </View>
        ) : null}
        {row.linked ? (
          <Text className="mt-0.5 text-2xs text-muted">
            Category linked from the finance plan
          </Text>
        ) : null}
      </Cell>
      <Cell flex={2}>
        {row.status ? (
          <Badge label={row.status} tone="neutral" />
        ) : (
          <Text className="text-xs text-faint">—</Text>
        )}
      </Cell>
      <Cell width={110} align="right">
        <CostCell row={row} />
      </Cell>
      <Cell width={28} align="center">
        {onOpen ? (
          <Pressable onPress={onOpen} hitSlop={8} className="active:opacity-70">
            <Icon name="chevron-right" size={15} color={colors.muted} />
          </Pressable>
        ) : null}
      </Cell>
    </Row>
  );
}

function CostCell({ row }: { row: GridRow }) {
  const updateEventItem = useMutation(api.items.updateEventItem);
  const updateEngagement = useMutation(api.engagements.update);
  const updateLine = useMutation(api.budgetLines.updateLine);
  const [amount, setAmount] = useState((row.plannedCents / 100).toString());
  const [saving, setSaving] = useState(false);
  // Tracks whether the field is actively being typed into — gates the
  // resync effect below so an external update (a fresh query result after
  // someone ELSE's edit, or this cell's own successful commit re-rendering)
  // never stomps text the user is mid-typing.
  const [focused, setFocused] = useState(false);

  // Opus review, PR #216 ("stale-input smell"): `amount` used to be seeded
  // ONCE from `row.plannedCents` on mount and never resynced — a concurrent
  // edit from someone else (or a server-side rounding difference) would
  // leave this cell showing a stale figure until the component remounted.
  useEffect(() => {
    if (!focused) setAmount((row.plannedCents / 100).toString());
  }, [row.plannedCents, focused]);

  if (!row.editable) {
    return (
      <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {formatCents(row.plannedCents)}
      </Text>
    );
  }

  async function commit() {
    const cents = dollarsToCents(amount);
    if (cents === null) {
      alertError(new Error("Enter a valid amount."));
      setAmount((row.plannedCents / 100).toString());
      return;
    }
    if (cents === row.plannedCents) return;
    setSaving(true);
    try {
      // `event_item` ids are `event_item:<itemId>:<columnKey>` (the currency
      // COLUMN this figure belongs to — may not be "cost" for a chapter-
      // custom column, e.g. Permits' "fee"). `vendor`/`budget_line` ids have
      // no third segment; `colKey` is simply unused for those.
      const [kind, id, colKey] = row.id.split(":");
      if (kind === "event_item") {
        await updateEventItem({
          itemId: id as Id<"eventItems">,
          fields: { [colKey ?? "cost"]: cents / 100 },
        });
      } else if (kind === "vendor") {
        await updateEngagement({
          engagementId: id as Id<"engagements">,
          amountUsd: cents / 100,
        });
      } else {
        await updateLine({ lineId: id as Id<"budgetLines">, patch: { plannedCents: cents } });
      }
      // Opus review, PR #216 ("$0-edit UX gotcha"): a cleared/zeroed cost is
      // a REAL write, but rows with no cost never appear in this list — the
      // row will vanish on the next read. Say so, rather than a silent
      // disappearance with no explanation.
      if (cents === 0) {
        alertInfo("This row will disappear from the list — it no longer has a cost to show.");
      }
    } catch (err) {
      alertError(err);
      setAmount((row.plannedCents / 100).toString());
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="w-24 flex-row items-center justify-end rounded-md border border-border-strong bg-raised px-2">
      <Text className="text-sm text-faint">$</Text>
      <TextInput
        value={amount}
        onChangeText={setAmount}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void commit();
        }}
        onSubmitEditing={() => void commit()}
        editable={!saving}
        keyboardType="decimal-pad"
        className="flex-1 py-1.5 text-right text-sm text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      />
    </View>
  );
}

/** A minimal "what's this for + how much" add form for Task/Supply/Comms,
 *  identical in spirit to `BudgetLineItemsEditor#AddLineForm`. Vendor deep
 *  links to Crew & Duties instead of adding inline (needs a person picker). */
function AddRow({ eventId, onDone }: { eventId: Id<"events">; onDone: () => void }) {
  const router = useRouter();
  const addEventItem = useMutation(api.items.addEventItem);
  const [type, setType] = useState("planning_doc");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (type === "vendor") {
      router.push(`/event/${eventId}?tab=crew` as never);
      onDone();
      return;
    }
    const trimmed = title.trim();
    if (!trimmed) {
      alertError(new Error("Enter what this is for."));
      return;
    }
    const cents = dollarsToCents(amount);
    setSaving(true);
    try {
      await addEventItem({
        eventId,
        module: type,
        title: trimmed,
        fields: cents !== null ? { cost: cents / 100 } : undefined,
      });
      setTitle("");
      setAmount("");
      onDone();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-3 gap-2 rounded-lg border border-dashed border-border p-3">
      <Select value={type} options={ADD_TYPE_OPTIONS} onChange={setType} label="Type" />
      {type !== "vendor" ? (
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What's this for?"
              placeholderTextColor={colors.faint}
              className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
            />
          </View>
          <View className="w-24">
            <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
              <Text className="text-base text-faint">$</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="0"
                placeholderTextColor={colors.faint}
                keyboardType="decimal-pad"
                className="flex-1 py-2 text-base text-ink"
              />
            </View>
          </View>
        </View>
      ) : (
        <Text className="text-xs text-muted">
          Vendors are added from Crew & Duties (picks a real person).
        </Text>
      )}
      <View className="flex-row justify-end">
        <Button
          title={type === "vendor" ? "Open Crew & Duties" : "Add"}
          icon="plus"
          size="sm"
          loading={saving}
          onPress={() => void handleAdd()}
        />
      </View>
    </View>
  );
}
