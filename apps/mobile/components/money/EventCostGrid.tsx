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
import { useState } from "react";
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
import { alertError } from "../../lib/errors";

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
                <HeaderCell flex={3}>{typeLabel}s</HeaderCell>
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
        <Text className="text-sm text-ink" numberOfLines={1}>
          {row.label}
        </Text>
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
      const [kind, id] = row.id.split(":");
      if (kind === "event_item") {
        await updateEventItem({
          itemId: id as Id<"eventItems">,
          fields: { cost: cents / 100 },
        });
      } else if (kind === "vendor") {
        await updateEngagement({
          engagementId: id as Id<"engagements">,
          amountUsd: cents / 100,
        });
      } else {
        await updateLine({ lineId: id as Id<"budgetLines">, patch: { plannedCents: cents } });
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
        onBlur={() => void commit()}
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
