/**
 * RECONCILE GRID — the inline-editable spreadsheet the bookkeeper codes charges
 * in, built on the shared EditableTable primitives (the `people.tsx` pattern):
 * fixed `COLS` widths, a `GridHeaderCell` header row, and per-row `Cell`-wrapped
 * cells that each commit ONE field via its own mutation.
 *
 * Columns: [☐] Merchant · Date · Amount · Cardholder · Category▾ · Budget▾ ·
 * Link▾ · Suggested · Receipt · Status▾. Category / Budget / Link / Status edit
 * inline (dropdowns, commit per row); Suggested shows the AI auto-coding
 * proposal (when present + unreviewed) with an Accept action; Receipt shows ✓
 * or an inline upload; Amount is read-only (signed). The fund is hidden — the
 * backend defaults it to the General Fund on categorize.
 */
import { useState } from "react";
import { View, Text, Pressable, Platform, ScrollView } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Avatar,
  Badge,
  Button,
  Icon,
  OptionTag,
  Popover,
  SelectCell,
  GridHeaderCell,
  useAnchor,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { STATUS_OPTIONS, signedMoney, shortDate, type TxnRow } from "./helpers";

const NUM = { fontVariant: ["tabular-nums" as const] };

/** An option in the Category / Budget / Link pickers; `header` rows are
 *  non-selectable. Link picker values are `"event:<id>"` / `"project:<id>"`. */
export type PickerItem = { value: string; label: string; header?: boolean };

// Fixed column widths (px) — the grid scrolls horizontally on narrow web while
// columns stay put, mirroring the People roster grid.
const COLS = {
  check: 40,
  merchant: 210,
  date: 92,
  amount: 104,
  cardholder: 168,
  category: 168,
  budget: 180,
  link: 180,
  suggested: 220,
  receipt: 96,
  status: 148,
} as const;
const TABLE_WIDTH = Object.values(COLS).reduce((sum, w) => sum + w, 0);

export function ReconcileList({
  rows,
  categoryItems,
  budgetItems,
  linkItems,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: TxnRow[];
  categoryItems: PickerItem[];
  budgetItems: PickerItem[];
  linkItems: PickerItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(TABLE_WIDTH, 320) }}>
          {/* Column header */}
          <View className="flex-row items-center border-b border-border bg-sunken">
            <View
              style={{ width: COLS.check }}
              className="items-center justify-center py-2.5"
            >
              <CheckBox checked={allSelected} onPress={onToggleAll} />
            </View>
            <GridHeaderCell label="Merchant" width={COLS.merchant} />
            <GridHeaderCell label="Date" width={COLS.date} />
            <GridHeaderCell label="Amount" width={COLS.amount} />
            <GridHeaderCell label="Cardholder" width={COLS.cardholder} />
            <GridHeaderCell label="Category" width={COLS.category} />
            <GridHeaderCell label="Budget" width={COLS.budget} />
            <GridHeaderCell label="Link" width={COLS.link} />
            <GridHeaderCell label="Suggested" width={COLS.suggested} />
            <GridHeaderCell label="Receipt" width={COLS.receipt} />
            <GridHeaderCell label="Status" width={COLS.status} />
          </View>

          {/* Body */}
          {rows.map((row, i) => (
            <ReconcileRow
              key={row.id}
              row={row}
              categoryItems={categoryItems}
              budgetItems={budgetItems}
              linkItems={linkItems}
              selected={selected.has(row.id)}
              onToggle={() => onToggle(row.id)}
              isLast={i === rows.length - 1}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function ReconcileRow({
  row,
  categoryItems,
  budgetItems,
  linkItems,
  selected,
  onToggle,
  isLast,
}: {
  row: TxnRow;
  categoryItems: PickerItem[];
  budgetItems: PickerItem[];
  linkItems: PickerItem[];
  selected: boolean;
  onToggle: () => void;
  isLast: boolean;
}) {
  const categorize = useMutation(api.finances.categorizeTransaction);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const acceptSuggestion = useMutation(api.aiCodingData.acceptSuggestion);
  const id = row.id as Id<"transactions">;

  // Fire-and-surface: run a cell mutation, alerting the server's reason on error.
  const guard = (p: Promise<unknown>) => p.catch((err) => alertError(err));

  // The Link picker's current composite value ("event:<id>" / "project:<id>").
  const linkValue = row.projectId
    ? `project:${row.projectId}`
    : row.eventId
      ? `event:${row.eventId}`
      : null;

  function onLinkChange(value: string | null) {
    if (!value) {
      guard(categorize({ transactionId: id, projectId: null, eventId: null }));
      return;
    }
    const [kind, refId] = value.split(":");
    if (kind === "project") {
      guard(
        categorize({
          transactionId: id,
          projectId: refId as Id<"projects">,
          eventId: null,
        }),
      );
    } else if (kind === "event") {
      guard(
        categorize({
          transactionId: id,
          eventId: refId as Id<"events">,
          projectId: null,
        }),
      );
    }
  }

  return (
    <View
      className={`flex-row items-stretch border-b border-border ${
        selected ? "bg-accent-soft" : "bg-raised"
      } ${isLast ? "border-b-0" : ""}`}
    >
      {/* Select checkbox */}
      <View
        style={{ width: COLS.check }}
        className="items-center justify-center border-r border-border/60"
      >
        <CheckBox checked={selected} onPress={onToggle} />
      </View>

      {/* Merchant (read-only) */}
      <Cell width={COLS.merchant}>
        <Text
          className="flex-1 px-2 py-1.5 text-sm font-medium text-ink"
          numberOfLines={1}
        >
          {row.merchantName ?? "Unlabeled charge"}
        </Text>
      </Cell>

      {/* Date (read-only) */}
      <Cell width={COLS.date}>
        <Text className="flex-1 px-2 py-1.5 text-sm text-muted" style={NUM}>
          {shortDate(row.postedAt)}
        </Text>
      </Cell>

      {/* Amount (read-only, signed) */}
      <Cell width={COLS.amount}>
        <Text
          className="flex-1 px-2 py-1.5 text-right text-sm font-semibold text-ink"
          style={NUM}
        >
          {signedMoney(row.amountCents, row.flow)}
        </Text>
      </Cell>

      {/* Cardholder (read-only) */}
      <Cell width={COLS.cardholder}>
        {row.cardholder ? (
          <View className="flex-1 flex-row items-center gap-2 px-2 py-1.5">
            <Avatar
              name={row.cardholder.name || "?"}
              size={22}
              uri={row.cardholder.imageUrl}
            />
            <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
              {row.cardholder.name}
            </Text>
          </View>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
        )}
      </Cell>

      {/* Category (inline dropdown) */}
      <Cell width={COLS.category}>
        <PickerCell
          value={row.categoryId}
          items={categoryItems}
          placeholder="Uncategorized"
          onChange={(value) =>
            guard(
              categorize({
                transactionId: id,
                categoryId: value as Id<"budgetCategories"> | null,
              }),
            )
          }
        />
      </Cell>

      {/* Budget (inline dropdown; grouped Chapter / Central) */}
      <Cell width={COLS.budget}>
        <PickerCell
          value={row.budgetId}
          items={budgetItems}
          placeholder={row.needsBudget ? "Needs budget" : "None"}
          warn={row.needsBudget}
          onChange={(value) =>
            guard(
              categorize({
                transactionId: id,
                budgetId: value as Id<"budgets"> | null,
              }),
            )
          }
        />
      </Cell>

      {/* Link (inline dropdown; grouped Events / Projects — "what was it for") */}
      <Cell width={COLS.link}>
        <PickerCell
          value={linkValue}
          items={linkItems}
          placeholder="Unlinked"
          onChange={onLinkChange}
        />
      </Cell>

      {/* Suggested (AI auto-coding proposal + Accept — only present when the
          row is still unreviewed and the model proposed at least one link) */}
      <Cell width={COLS.suggested}>
        {row.aiSuggestion ? (
          <View className="flex-1 gap-1 px-2 py-1.5">
            <Badge
              label={`AI: ${[
                row.aiSuggestion.fundName,
                row.aiSuggestion.categoryName,
                row.aiSuggestion.projectName ?? row.aiSuggestion.eventName,
              ]
                .filter(Boolean)
                .join(" · ")}`}
              tone="lavender"
              icon="sparkles"
            />
            <Button
              title="Accept"
              size="sm"
              variant="secondary"
              onPress={() => guard(acceptSuggestion({ transactionId: id }))}
            />
          </View>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
        )}
      </Cell>

      {/* Receipt (✓ or inline upload) */}
      <Cell width={COLS.receipt}>
        <ReceiptCell
          hasReceipt={row.hasReceipt}
          onUpload={async (storageId) => {
            await guard(attachReceipt({ transactionId: id, storageId }));
          }}
          generateUploadUrl={generateUploadUrl}
        />
      </Cell>

      {/* Status (inline dropdown) */}
      <Cell width={COLS.status}>
        <SelectCell
          value={row.status}
          options={STATUS_OPTIONS}
          onChange={(v) => guard(setStatus({ transactionId: id, status: v }))}
        />
      </Cell>
    </View>
  );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <View
      style={{ width }}
      className="flex-row items-center border-r border-border/60"
    >
      {children}
    </View>
  );
}

// ── Checkbox ──────────────────────────────────────────────────────────────────
function CheckBox({
  checked,
  onPress,
}: {
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="rounded p-1 active:opacity-70"
    >
      <View
        className={`h-4 w-4 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
        }`}
      >
        {checked ? <Icon name="check" size={12} color={colors.accentText} /> : null}
      </View>
    </Pressable>
  );
}

// ── Category / Budget picker cell (a Popover of options + a "None" clear) ──────
function PickerCell({
  value,
  items,
  placeholder,
  warn,
  onChange,
}: {
  value: string | null;
  items: PickerItem[];
  placeholder: string;
  warn?: boolean;
  /** `""` clears the field (mapped to `null`). */
  onChange: (value: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const current = items.find((i) => !i.header && i.value === value);

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
      >
        {current ? (
          <OptionTag label={current.label} />
        ) : (
          <Text className={`text-sm ${warn ? "text-warn" : "text-faint"}`}>
            {placeholder}
          </Text>
        )}
      </Pressable>
      <Popover visible={visible} onClose={close} anchor={anchor}>
        <View className="py-1">
          {items.map((it) =>
            it.header ? (
              <Text
                key={it.value}
                className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-muted"
              >
                {it.label}
              </Text>
            ) : (
              <Pressable
                key={it.value}
                onPress={() => {
                  onChange(it.value === "" ? null : it.value);
                  close();
                }}
                className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
              >
                {it.value === "" ? (
                  <Text className="text-sm text-muted">{it.label}</Text>
                ) : (
                  <OptionTag label={it.label} />
                )}
                {it.value === (value ?? "") ? (
                  <Icon name="check" size={15} color={colors.accent} />
                ) : null}
              </Pressable>
            ),
          )}
        </View>
      </Popover>
    </>
  );
}

// ── Receipt cell: a green ✓ when attached, else a web file-upload affordance ───
function ReceiptCell({
  hasReceipt,
  onUpload,
  generateUploadUrl,
}: {
  hasReceipt: boolean;
  onUpload: (storageId: Id<"_storage">) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);

  // Web file input → R2 upload → attach (mirrors the People avatar upload flow).
  function pick() {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        const { storageId } = await res.json();
        await onUpload(storageId as Id<"_storage">);
      } finally {
        setBusy(false);
      }
    };
    input.click();
  }

  if (hasReceipt) {
    return (
      <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
        <Icon name="check-circle" size={15} color={colors.success} />
        <Text className="text-sm font-medium text-success">Attached</Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={pick}
      disabled={busy}
      className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      <Icon name="upload" size={14} color={colors.muted} />
      <Text className="text-sm text-muted">{busy ? "Uploading…" : "Upload"}</Text>
    </Pressable>
  );
}
