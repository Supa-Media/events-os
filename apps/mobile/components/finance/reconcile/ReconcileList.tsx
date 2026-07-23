/**
 * RECONCILE GRID — the inline-editable spreadsheet the bookkeeper codes charges
 * in, built on the shared EditableTable primitives (the `people.tsx` pattern):
 * fixed `COLS` widths, a `GridHeaderCell` header row, and per-row `Cell`-wrapped
 * cells that each commit ONE field via its own mutation.
 *
 * Columns: [☐] Merchant · Date · Amount · Cardholder · Category▾ · For▾ ·
 * Suggested · Receipt · Status▾ · Actions. Category / For / Status edit
 * inline (dropdowns, commit per row); Suggested shows the AI auto-coding
 * proposal (when present + unreviewed) with an Accept action; Receipt shows
 * ✓ or an inline upload; Amount is read-only (signed). The fund is hidden —
 * the backend defaults it to the General Fund on categorize.
 *
 * Suggested / on-demand "Suggest": most unreviewed charges already carry a
 * proposal by the time the bookkeeper opens this grid — new transactions get
 * one within seconds of arriving (the on-ingest sweep, see
 * `aiCodingData.scheduleSuggestionOnIngest`), not just on the old hourly
 * cron. A still-`isSuggestible` row (`helpers.ts#isSuggestible` — unreviewed,
 * OR categorized but still needing a budget; PR fix-suggest-broaden) that
 * STILL has none (the on-ingest/hourly sweep's batch cap was exceeded,
 * OPENROUTER_API_KEY was unset when it landed, or a prior attempt failed and
 * is still cooling down) shows a "Suggest" button instead of the AI badge —
 * tapping it runs the exact same model-call core (`aiCoding.suggestCoding`)
 * for just that one transaction, on demand (`SuggestCell` below). Either path
 * lands in the same Accept/reject UI. A "Categorized" row whose "For" cell
 * still reads "Needs budget" is the majority of the backlog this covers — the
 * button used to only ever render on an unreviewed row, leaving that whole
 * bucket stuck at a bare "—" with no way to trigger a suggestion.
 *
 * The "For" column (WP-U: one home per dollar) replaces the old separate
 * Budget + Link columns/pickers with ONE picker, grouped Events / Projects /
 * Recurring — see `forPicker.ts`. WP-wave4 (item 5, owner addendum
 * 2026-07-17): only a ref with an APPROVED budget is ever offered
 * (`isAttributableBudget`, filtered server-side by both `forPickerOptions`
 * and `reconcileSuggest.rankForPicker`), so a picked value is always a real
 * `budgetId` already — `categorizeTransaction` accepts a `budgetId` only,
 * never a separate event/project link, and the old "summon a $0 budget on
 * pick" flow is retired.
 *
 * Actions (R1): a note icon (filled when set, tap → `TransactionNoteModal`)
 * and, for a finance MANAGER on a card charge that isn't already personal, a
 * "Mark personal" flag — the manager path of `cards.flagPersonalCharge` (#147)
 * had no Reconcile entry point before this; the member's own "My transactions"
 * flag flow is untouched. The flag's state is REAL now (R1b follow-up):
 * `listReconcile` rows carry `isPersonal` + the linked repayment's live
 * `repaymentStatus`, so the badge reads "Personal" (awaiting repayment) or
 * "Repaid" from the payload — the old session-local "what did I just flag"
 * state (which forgot on reload and never showed a member/manager flag made
 * elsewhere) is gone.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Platform, ScrollView, TextInput } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
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
import { TransactionNoteModal } from "../modals/TransactionNoteModal";
import { ReceiptViewerModal } from "../receipts/ReceiptViewerModal";
import {
  STATUS_OPTIONS,
  isSuggestible,
  signedMoney,
  shortDate,
  type TxnRow,
} from "./helpers";
import { buildRankedForPickerItems, type RankForPickerResult } from "./forPicker";

const NUM = { fontVariant: ["tabular-nums" as const] };
// Server-side search debounce (owner addendum) — a round trip per keystroke
// is wasteful; this mirrors `LocationAutocomplete`'s own debounce window.
const SEARCH_DEBOUNCE_MS = 200;

/** An option in the Category / For pickers; `header` rows are non-selectable.
 *  A "For" value is either a real `budgetId`, or a `summon:<refKind>:<id>`
 *  summon-candidate — see `forPicker.ts`. `reason` (ranked "For" rows only)
 *  renders as a small sublabel — "2 transactions nearby in June", etc. */
export type PickerItem = { value: string; label: string; header?: boolean; reason?: string };

// Fixed column widths (px) — the grid scrolls horizontally on narrow web while
// columns stay put, mirroring the People roster grid.
const COLS = {
  check: 40,
  merchant: 210,
  date: 118, // fits "Mar 15, 2026" — year added for multi-year history

  amount: 104,
  cardholder: 168,
  category: 168,
  forCol: 200,
  suggested: 220,
  receipt: 96,
  status: 148,
  // Wide enough for the note icon PLUS the "Personal" badge (its widest
  // combination — the note icon + the manager-only flag icon is narrower).
  // 76px clipped/overlapped the badge's text.
  actions: 112,
} as const;
const TABLE_WIDTH = Object.values(COLS).reduce((sum, w) => sum + w, 0);

export function ReconcileList({
  rows,
  categoryItems,
  forItems,
  selected,
  onToggle,
  onToggleAll,
  centralScope = false,
  isManager = false,
}: {
  rows: TxnRow[];
  categoryItems: PickerItem[];
  forItems: PickerItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  // WP-2.1: reconciling CENTRAL-owned txns. Central money carries no
  // chapter-scoped links (funds/categories/projects/events are chapter-only), so
  // the Category column is hidden — central coding is For + Status.
  centralScope?: boolean;
  // R1b: the caller's finance-MANAGER rank (not just any finance seat) — gates
  // the "Mark personal" row action, which mirrors `cards.flagPersonalCharge`'s
  // own server-side manager-or-cardholder authz.
  isManager?: boolean;
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  // Drop the chapter-only Category column's width in central scope so the
  // grid doesn't leave dead space.
  const width = centralScope ? TABLE_WIDTH - COLS.category : TABLE_WIDTH;

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(width, 320) }}>
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
            {!centralScope ? (
              <GridHeaderCell label="Category" width={COLS.category} />
            ) : null}
            <GridHeaderCell label="For" width={COLS.forCol} />
            <GridHeaderCell label="Suggested" width={COLS.suggested} />
            <GridHeaderCell label="Receipt" width={COLS.receipt} />
            <GridHeaderCell label="Status" width={COLS.status} />
            <View style={{ width: COLS.actions }} />
          </View>

          {/* Body */}
          {rows.map((row, i) => (
            <ReconcileRow
              key={row.id}
              row={row}
              categoryItems={categoryItems}
              forItems={forItems}
              selected={selected.has(row.id)}
              onToggle={() => onToggle(row.id)}
              isLast={i === rows.length - 1}
              centralScope={centralScope}
              isManager={isManager}
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
  forItems,
  selected,
  onToggle,
  isLast,
  centralScope,
  isManager,
}: {
  row: TxnRow;
  categoryItems: PickerItem[];
  forItems: PickerItem[];
  selected: boolean;
  onToggle: () => void;
  isLast: boolean;
  centralScope: boolean;
  isManager: boolean;
}) {
  const categorize = useMutation(api.finances.categorizeTransaction);
  const setStatus = useMutation(api.finances.setTransactionStatus);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const acceptSuggestion = useMutation(api.aiCodingData.acceptSuggestion);
  const flagPersonalCharge = useMutation(api.cards.flagPersonalCharge);
  const id = row.id as Id<"transactions">;

  // Fire-and-surface: run a cell mutation, alerting the server's reason on error.
  const guard = (p: Promise<unknown>) => p.catch((err) => alertError(err));

  const [noteModalOpen, setNoteModalOpen] = useState(false);

  async function handleMarkPersonal() {
    try {
      // No local flagged state needed: `listReconcile`'s live subscription
      // re-renders this row with `isPersonal` set the moment the flag commits.
      await flagPersonalCharge({ transactionId: id });
    } catch (err) {
      alertError(err);
    }
  }

  // The "For" picker's value is just `budgetId` (WP-U: one home per dollar) —
  // always a real, APPROVED budget already (item 5) — no summon/resolution
  // step needed.
  function onForChange(value: string | null) {
    guard(
      categorize({
        transactionId: id,
        budgetId: value ? (value as Id<"budgets">) : null,
      }),
    );
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
          {row.merchantName ?? row.description ?? "Unlabeled charge"}
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

      {/* Category (inline dropdown) — chapter-only; central txns have none. */}
      {!centralScope ? (
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
      ) : null}

      {/* For (inline dropdown; grouped Events / Projects / Recurring — WP-U:
          one picker, one home per dollar. In central scope only Recurring ·
          Central budgets are offered — events/projects are chapter-only).
          RANKED per-row (nearby spend → similar merchant → upcoming date →
          everything else, budget-less demoted) via `reconcileSuggest.
          rankForPicker` — see `ForPickerCell`. */}
      <Cell width={COLS.forCol}>
        <ForPickerCell
          value={row.budgetId}
          transactionId={id}
          baseItems={forItems}
          placeholder={row.needsBudget ? "Needs budget" : "None"}
          warn={row.needsBudget}
          onChange={onForChange}
        />
      </Cell>

      {/* Suggested — AI auto-coding proposal + Accept when the model has
          already proposed something for this (still-unreviewed) row; a
          still-unreviewed row with NO suggestion yet offers an on-demand
          "Suggest" button instead (`SuggestCell`) rather than a bare dash —
          most new charges are suggested within seconds on arrival, but the
          batch cap / a cooling-down failed attempt / a stale charge that
          predates the feature can still leave one without one. */}
      <Cell width={COLS.suggested}>
        {row.aiSuggestion ? (
          <View className="flex-1 gap-1 px-2 py-1.5">
            <Badge
              label={`AI: ${[row.aiSuggestion.categoryName, row.aiSuggestion.budgetName]
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
        ) : isSuggestible(row) ? (
          <View className="flex-1 px-2 py-1.5">
            <SuggestCell transactionId={id} />
          </View>
        ) : (
          <Text className="flex-1 px-2 py-1.5 text-sm text-faint">—</Text>
        )}
      </Cell>

      {/* Receipt (✓ or inline upload, escalating with the reminder timeline) */}
      <Cell width={COLS.receipt}>
        <ReceiptCell
          hasReceipt={row.hasReceipt}
          reminderStage={row.reminderStage}
          transactionId={id}
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

      {/* Actions (R1): note (icon fills in when set) + manager-only "Mark
          personal" on a card charge that isn't already personal. A flagged
          charge shows its REAL repayment state ("Personal" until the
          cardholder pays it back, then "Repaid") from the row payload. */}
      <Cell width={COLS.actions}>
        <View className="flex-1 flex-row items-center justify-center gap-2 px-1">
          <Pressable
            onPress={() => setNoteModalOpen(true)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={row.note ? "Edit note" : "Add note"}
            className="rounded p-1 active:opacity-70 web:hover:opacity-90"
          >
            <Icon
              name="message-square"
              size={15}
              color={row.note ? colors.accent : colors.faint}
            />
          </Pressable>
          {row.isPersonal ? (
            row.repaymentStatus === "paid" ? (
              <Badge label="Repaid" tone="success" />
            ) : (
              <Badge label="Personal" tone="accent" />
            )
          ) : isManager && row.cardLast4 != null ? (
            <Pressable
              onPress={handleMarkPersonal}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Mark personal"
              className="rounded p-1 active:opacity-70 web:hover:opacity-90"
            >
              <Icon name="flag" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </Cell>

      {noteModalOpen ? (
        <TransactionNoteModal
          transactionId={id}
          currentNote={row.note}
          onClose={() => setNoteModalOpen(false)}
        />
      ) : null}
    </View>
  );
}

// ── On-demand "Suggest" (Suggested column, unreviewed row with no proposal
// yet) — runs the same model-call core as the on-ingest/hourly sweep
// (`api.aiCoding.suggestCoding`) for just this one transaction. Bookkeeper+
// gated server-side (`loadForSuggestion`'s finance-role check, same rank the
// rest of this grid's writes require) — a caller without the role sees the
// button fail with a readable error via `alertError`, same as every other
// cell's `guard()`. Loading state is local (`busy`): the button shows a
// spinner while the OpenRouter call is in flight and disables itself so a
// double-tap can't fire two calls; on error it re-enables — tapping again is
// the retry, no separate affordance needed. Success needs no local handling
// at all: `listReconcile`'s live subscription re-renders this row with
// `aiSuggestion` set the moment `writeSuggestion` commits, swapping this
// button out for the normal Accept UI above. ──────────────────────────────
function SuggestCell({ transactionId }: { transactionId: Id<"transactions"> }) {
  const suggestCoding = useAction(api.aiCoding.suggestCoding);
  const [busy, setBusy] = useState(false);

  async function handleSuggest() {
    setBusy(true);
    try {
      await suggestCoding({ transactionId });
    } catch (err) {
      alertError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      title="Suggest"
      size="sm"
      variant="secondary"
      icon="sparkles"
      loading={busy}
      onPress={handleSuggest}
    />
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

// ── "For" picker cell — RANKED, per-transaction (`reconcileSuggest.
// rankForPicker` via `forPicker.ts#buildRankedForPickerItems`). A mini search
// box (owner addendum) sits at the top of the popover, auto-focusing the
// moment it opens, and drives the ranking query's `search` arg server-side
// (debounced — every keystroke would otherwise be a round trip). Only fires
// the ranking query while the popover is actually open (`useAnchor`'s
// `visible`, Convex's "skip" pattern) — a grid full of unopened "For" cells
// costs nothing beyond the base `forItems` this cell falls back to while the
// ranked list is in flight, so the popover is never blank. ──────────────────
function ForPickerCell({
  value,
  transactionId,
  baseItems,
  placeholder,
  warn,
  onChange,
}: {
  value: string | null;
  transactionId: Id<"transactions">;
  baseItems: PickerItem[];
  placeholder: string;
  warn?: boolean;
  /** `""` clears the field (mapped to `null`). */
  onChange: (value: string | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, visible]);

  const ranked = useQuery(
    api.reconcileSuggest.rankForPicker,
    visible ? { transactionId, search: debouncedSearch.trim() || undefined } : "skip",
  );
  // Keep the LAST resolved ranked payload rendered while a new args-tuple
  // (a debounce settle changing `search`) is in flight — `useQuery` returns
  // `undefined` for the whole round trip of a genuinely new subscription, so
  // without this every keystroke settle would flash the popover from the
  // current (possibly search-filtered) results all the way back to the
  // unranked `baseItems` fallback and then back again once the new result
  // lands. Reset on close so a FRESH open never shows a stale previous
  // search's results before its own default-view query resolves.
  const lastRankedRef = useRef<RankForPickerResult | undefined>(undefined);
  useEffect(() => {
    if (!visible) lastRankedRef.current = undefined;
  }, [visible]);
  if (ranked !== undefined) lastRankedRef.current = ranked;
  const effectiveRanked = ranked ?? lastRankedRef.current;

  const items = effectiveRanked ? buildRankedForPickerItems(effectiveRanked) : baseItems;
  const current = baseItems.find((i) => !i.header && i.value === value);
  const noMatches = effectiveRanked?.searching === true && items.length === 0;

  function handleClose() {
    close();
    setSearch("");
    setDebouncedSearch("");
  }

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
      <Popover visible={visible} onClose={handleClose} anchor={anchor}>
        <View className="border-b border-border/60 px-2 py-1.5">
          <View className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-sunken px-2 py-1">
            <Icon name="search" size={12} color={colors.faint} />
            <TextInput
              autoFocus
              value={search}
              onChangeText={setSearch}
              placeholder="Search…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 py-0.5 text-xs text-ink"
            />
          </View>
        </View>
        <View className="py-1">
          {noMatches ? (
            <Text className="px-3 py-2 text-sm text-faint">No matches</Text>
          ) : (
            items.map((it) =>
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
                    handleClose();
                  }}
                  className="flex-row items-center justify-between gap-3 px-3 py-2 active:bg-sunken web:hover:bg-sunken"
                >
                  <View className="flex-1">
                    {it.value === "" ? (
                      <Text className="text-sm text-muted">{it.label}</Text>
                    ) : (
                      <OptionTag label={it.label} />
                    )}
                    {it.reason ? (
                      <Text className="mt-0.5 text-2xs text-faint" numberOfLines={1}>
                        {it.reason}
                      </Text>
                    ) : null}
                  </View>
                  {it.value === (value ?? "") ? (
                    <Icon name="check" size={15} color={colors.accent} />
                  ) : null}
                </Pressable>
              ),
            )
          )}
        </View>
        {effectiveRanked?.truncated ? (
          <Text className="border-t border-border/60 px-3 py-1.5 text-2xs text-faint">
            Ranked from recent history
          </Text>
        ) : null}
      </Popover>
    </>
  );
}

// ── Receipt cell: a green ✓ when attached, else a web file-upload affordance
// that escalates in color/copy with the receipt-reminder timeline (day-1
// flag → day-3 escalate; day-7 auto-lock is shown at the card level).
// Exported so the member "My transactions" mini-reconcile (finances/
// my-transactions.tsx) can reuse the exact same upload affordance instead of
// re-implementing the web file-input → R2 upload → attach dance. ────────────
export function ReceiptCell({
  hasReceipt,
  reminderStage,
  transactionId,
  onUpload,
  generateUploadUrl,
}: {
  hasReceipt: boolean;
  reminderStage: "none" | "flagged" | "escalated";
  /** Which transaction this cell's receipt(s) belong to — powers the
   *  "Attached" chip's tap-to-view (`ReceiptViewerModal`, below). Optional so
   *  an existing call site outside this PR's file boundary (`money/MoneyView.tsx`)
   *  keeps compiling unchanged; omitting it just falls back to the old inert
   *  chip rather than opening a viewer. */
  transactionId?: Id<"transactions">;
  onUpload: (storageId: Id<"_storage">) => Promise<void>;
  generateUploadUrl: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string) {
    setBusy(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      await onUpload(storageId as Id<"_storage">);
    } finally {
      setBusy(false);
    }
  }

  // Web file input → R2 upload → attach (mirrors the People avatar upload flow).
  function pickWeb() {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "application/octet-stream");
    };
    input.click();
  }

  // Native picker (`expo-image-picker`) — mirrors `CoverPhotoPicker`/
  // `RequestForm`'s own pick → blob → upload dance. Images only on native (no
  // PDF picker available there — the same limitation those two call sites
  // already accept); the web `pickWeb()` above still takes PDFs too.
  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  function pick() {
    if (Platform.OS === "web") pickWeb();
    else void pickNative();
  }

  if (hasReceipt) {
    if (!transactionId) {
      // No transaction to view receipts for (see the prop's own doc comment)
      // — the old inert chip, unchanged.
      return (
        <View className="flex-1 flex-row items-center gap-1 px-2 py-1.5">
          <Icon name="check-circle" size={15} color={colors.success} />
          <Text className="text-sm font-medium text-success">Attached</Text>
        </View>
      );
    }
    return (
      <>
        <Pressable
          onPress={() => setViewerOpen(true)}
          className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
        >
          <Icon name="check-circle" size={15} color={colors.success} />
          <Text className="text-sm font-medium text-success">Attached</Text>
        </Pressable>
        {viewerOpen ? (
          <ReceiptViewerModal
            transactionId={transactionId}
            onClose={() => setViewerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  const escalated = reminderStage === "escalated";
  const flagged = reminderStage === "flagged";
  const tint = escalated ? colors.danger : flagged ? colors.warn : colors.muted;
  const label = busy
    ? "Uploading…"
    : escalated
      ? "Day 3 overdue"
      : flagged
        ? "Reminder sent"
        : "Upload";

  return (
    <Pressable
      onPress={pick}
      disabled={busy}
      className="flex-1 flex-row items-center gap-1 px-2 py-1.5 active:opacity-70 web:hover:opacity-90"
    >
      <Icon name={escalated ? "alert-triangle" : "upload"} size={14} color={tint} />
      <Text
        className={`text-sm ${escalated ? "text-danger" : flagged ? "text-warn" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
