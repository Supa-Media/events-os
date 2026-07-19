/**
 * GIVING · Import — the canonical import screen (territories P6). Paste rows
 * (CSV or a plain paste from a spreadsheet), preview how each row will be
 * classified, then commit. Replaces the old CSV-backfill (which had no
 * mobile UI) and the recurring-import form that used to live inline on
 * `backers.tsx` — every row shape now goes through ONE flow:
 * `api.givingImport.previewImport` (read-only) → `api.givingImport.importCanonical`.
 *
 * The header row a paste is expected to have:
 *   rowType,name,email,phone,amount,date,source,externalRef,recurringMonthly,eventHint
 *
 * `rowType` is one of `gift` / `ticket` / `contact` / `recurring` — see the
 * in-screen legend. `amount`/`recurringMonthly` are DOLLARS (e.g. "50.00"),
 * converted to cents client-side; `date` is anything `Date.parse` accepts
 * (blank = now). Only `rowType` and `name` are required; every other column
 * may be blank for a given row.
 *
 * Preview shows a disposition per row, a summary, and — the check that
 * catches a misclassified Givebutter export before anything is written — the
 * gift/ticket row-count split. Suspected-duplicate gift rows are skipped on
 * commit unless "Include suspected duplicates" is on; the suspected list is
 * shown so a manager can eyeball them first. Manage-gated server-side
 * (`giving.manage` at `scope`).
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Cell,
  EmptyState,
  HeaderCell,
  Narrow,
  Pill,
  Row,
  Screen,
  SectionHeader,
  Table,
  TableHeader,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type GivingScope = "central" | Id<"chapters">;

const ROW_TYPES = ["gift", "ticket", "contact", "recurring"] as const;
type RowType = (typeof ROW_TYPES)[number];

// Derived from the server's own row validator (`previewImport`'s args), so a
// client-side row can never drift from what `givingImport.ts` actually
// accepts (e.g. the `source` field's exact GIFT_METHODS union).
type CanonicalRow = FunctionArgs<typeof api.givingImport.previewImport>["rows"][number];

type PreviewRow = {
  index: number;
  rowType: RowType;
  donorMatch: "new" | "email" | "phone" | "name" | "n/a";
  disposition: string;
  reason?: string;
};

const EXPECTED_HEADER =
  "rowType,name,email,phone,amount,date,source,externalRef,recurringMonthly,eventHint";

/** Parse a pasted paste/CSV into canonical rows. Naive comma-split (no
 *  quoted-field support) — matches the house convention every other paste
 *  importer in this app already uses. Skips blank lines, `#` comments, and a
 *  leading header row (detected by its first cell reading "rowtype"). */
function parseCanonicalRows(text: string): { rows: CanonicalRow[]; skipped: number } {
  const rows: CanonicalRow[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(",").map((c) => c.trim());
    const [rowTypeRaw, name, email, phone, amount, date, source, externalRef, recurringMonthly, eventHint] =
      cells;
    if (rowTypeRaw?.toLowerCase() === "rowtype") continue; // the header row
    const rowType = rowTypeRaw?.toLowerCase() as RowType;
    if (!ROW_TYPES.includes(rowType) || !name) {
      skipped++;
      continue;
    }
    const amountCents = amount ? Math.round(Number.parseFloat(amount) * 100) : undefined;
    const recurringMonthlyCents = recurringMonthly
      ? Math.round(Number.parseFloat(recurringMonthly) * 100)
      : undefined;
    const receivedAt = date ? Date.parse(date) : NaN;
    // `source` is free text here — the server validates it against the real
    // GIFT_METHODS union and rejects an unrecognized value; this cast just
    // satisfies the client-side type derived from that same validator.
    rows.push({
      rowType,
      name,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(amountCents !== undefined && Number.isFinite(amountCents) ? { amountCents } : {}),
      ...(Number.isFinite(receivedAt) ? { receivedAt } : {}),
      ...(source ? { source } : {}),
      ...(externalRef ? { externalRef } : {}),
      ...(recurringMonthlyCents !== undefined && Number.isFinite(recurringMonthlyCents)
        ? { recurringMonthlyCents }
        : {}),
      ...(eventHint ? { eventHint } : {}),
    } as CanonicalRow);
  }
  return { rows, skipped };
}

// ── Givebutter transactions export preset ────────────────────────────────────
// A separate paste shape from the canonical rows above: Givebutter's
// transactions export (`Campaign Title,…,Reference Number,First Name,…`). Its
// rows can't be classified by column alone — whether a campaign is mission
// giving or ticket sales is the manager's call — so this preset extracts the
// distinct campaign titles and lets the user map each to gift | ticket | skip,
// then produces the SAME canonical rows the server already accepts (no backend
// change). Uses a small quote-aware splitter because Givebutter quotes any
// campaign title / name containing a comma.

type GbRowKind = "gift" | "ticket" | "skip";

/** Quote-aware split of one Givebutter CSV line (handles `"…"` + `""`). */
function splitGbLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function gbHeaderIndex(headers: string[], name: string): number {
  const t = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === t);
}

type GbTxnRow = {
  campaign: string;
  name: string;
  email?: string;
  phone?: string;
  amountCents?: number;
  receivedAt?: number;
  externalRef?: string;
  isMonthly: boolean;
  refunded: boolean;
};

type GbTxnParse = { rows: GbTxnRow[]; campaigns: string[] };

/** Detect + parse a Givebutter transactions export; null if not that shape. */
function parseGivebutterTransactions(text: string): GbTxnParse | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 1) return null;
  const headers = splitGbLine(lines[0]);
  const iCampaign = gbHeaderIndex(headers, "Campaign Title");
  const iRef = gbHeaderIndex(headers, "Reference Number");
  const iFirst = gbHeaderIndex(headers, "First Name");
  if (iCampaign < 0 || iRef < 0 || iFirst < 0) return null; // not this export

  const iLast = gbHeaderIndex(headers, "Last Name");
  const iEmail = gbHeaderIndex(headers, "Email");
  const iPhone = gbHeaderIndex(headers, "Phone");
  const iAmount = gbHeaderIndex(headers, "Amount");
  const iDate = gbHeaderIndex(headers, "Transaction Date (UTC)");
  const iFreq = gbHeaderIndex(headers, "Frequency");
  const iRefund = gbHeaderIndex(headers, "Refund Date");

  const rows: GbTxnRow[] = [];
  const campaigns = new Set<string>();
  for (const raw of lines.slice(1)) {
    const cells = splitGbLine(raw);
    const name = [cells[iFirst], iLast >= 0 ? cells[iLast] : ""]
      .map((c) => (c ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (!name) continue;
    const campaign = (cells[iCampaign] ?? "").trim() || "(no campaign)";
    campaigns.add(campaign);
    const amountRaw = iAmount >= 0 ? (cells[iAmount] ?? "").replace(/[^0-9.]/g, "") : "";
    const amountCents = amountRaw ? Math.round(Number.parseFloat(amountRaw) * 100) : undefined;
    const dateMs = iDate >= 0 ? Date.parse((cells[iDate] ?? "").trim()) : NaN;
    const phoneDigits = iPhone >= 0 ? (cells[iPhone] ?? "").replace(/\D/g, "") : "";
    rows.push({
      campaign,
      name,
      ...(iEmail >= 0 && cells[iEmail]?.trim()
        ? { email: cells[iEmail].trim().toLowerCase() }
        : {}),
      ...(phoneDigits.length >= 10 ? { phone: phoneDigits } : {}),
      ...(amountCents !== undefined && Number.isFinite(amountCents) ? { amountCents } : {}),
      ...(Number.isFinite(dateMs) ? { receivedAt: dateMs } : {}),
      ...(iRef >= 0 && cells[iRef]?.trim() ? { externalRef: cells[iRef].trim() } : {}),
      isMonthly: iFreq >= 0 && (cells[iFreq] ?? "").trim().toLowerCase() === "monthly",
      refunded: iRefund >= 0 && (cells[iRefund] ?? "").trim() !== "",
    });
  }
  return { rows, campaigns: [...campaigns].sort() };
}

/** Build canonical rows from parsed GB txns + a per-campaign mapping. Refunded
 *  rows are dropped; a monthly frequency promotes a `gift` mapping to a
 *  `recurring` pledge row. */
function gbTransactionsToCanonical(
  parse: GbTxnParse,
  mapping: Record<string, GbRowKind>,
): CanonicalRow[] {
  const out: CanonicalRow[] = [];
  for (const r of parse.rows) {
    if (r.refunded) continue; // never import a refunded transaction
    const kind = mapping[r.campaign] ?? "skip";
    if (kind === "skip") continue;
    const base = {
      name: r.name,
      ...(r.email ? { email: r.email } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      ...(r.receivedAt !== undefined ? { receivedAt: r.receivedAt } : {}),
      ...(r.externalRef ? { externalRef: r.externalRef } : {}),
      source: "givebutter",
    };
    if (kind === "ticket") {
      out.push({ rowType: "ticket", ...base } as CanonicalRow);
    } else if (r.isMonthly) {
      out.push({
        rowType: "recurring",
        ...base,
        ...(r.amountCents !== undefined ? { recurringMonthlyCents: r.amountCents } : {}),
      } as CanonicalRow);
    } else {
      out.push({
        rowType: "gift",
        ...base,
        ...(r.amountCents !== undefined ? { amountCents: r.amountCents } : {}),
      } as CanonicalRow);
    }
  }
  return out;
}

function dispositionTone(disposition: string): BadgeTone {
  if (disposition === "new" || disposition === "matched-order") return "success";
  if (disposition === "duplicate" || disposition === "matched") return "info";
  if (disposition === "suspected-duplicate") return "warn";
  if (disposition === "invalid") return "danger";
  return "neutral"; // history-only
}

export default function ImportScreen() {
  const access = useQuery(api.givingPlatform.myGivingAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canManage || access.scope === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Manage access needed"
            message="Ask a development director to grant you manage access to import data."
          />
        </Narrow>
      </Screen>
    );
  }
  return <ImportBody scope={access.scope} />;
}

function ImportBody({ scope }: { scope: GivingScope }) {
  const [text, setText] = useState("");
  const [parseSkipped, setParseSkipped] = useState(0);
  // Givebutter transactions preset: detected from the pasted header. When
  // present, the per-campaign gift/ticket/skip mapping drives the canonical
  // rows instead of the plain `parseCanonicalRows` path.
  const gbParse = useMemo(() => parseGivebutterTransactions(text), [text]);
  const [gbMapping, setGbMapping] = useState<Record<string, GbRowKind>>({});
  const [previewArgs, setPreviewArgs] = useState<
    { scope: GivingScope; rows: CanonicalRow[] } | "skip"
  >("skip");
  const [allowSuspected, setAllowSuspected] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<{
    imported: { gifts: number; pledges: number; people: number };
    skippedDuplicates: number;
    skippedSuspected: number;
    skippedInvalid: number;
    ticketHistoryLinked: number;
    scheduledRemaining: number;
  } | null>(null);

  const preview = useQuery(
    api.givingImport.previewImport,
    previewArgs === "skip" ? "skip" : previewArgs,
  );
  const commit = useMutation(api.givingImport.importCanonical);

  function runPreview() {
    setCommitResult(null);
    setCommitError(null);
    if (gbParse) {
      // Givebutter transactions preset — map each campaign, then classify.
      const rows = gbTransactionsToCanonical(gbParse, gbMapping);
      setParseSkipped(0);
      setPreviewArgs(rows.length === 0 ? "skip" : { scope, rows });
      return;
    }
    const { rows, skipped } = parseCanonicalRows(text);
    setParseSkipped(skipped);
    if (rows.length === 0) {
      setPreviewArgs("skip");
      return;
    }
    setPreviewArgs({ scope, rows });
  }

  async function runCommit() {
    if (previewArgs === "skip") return;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await commit({ scope, rows: previewArgs.rows, allowSuspected });
      setCommitResult(result);
    } catch {
      setCommitError("Couldn't import — check your access and try again.");
    } finally {
      setCommitting(false);
    }
  }

  const suspectedRows = useMemo(
    () => (preview?.rows ?? []).filter((r) => r.disposition === "suspected-duplicate") as PreviewRow[],
    [preview],
  );

  return (
    <Screen>
      <Narrow>
        <SectionHeader title="Paste rows" />
        <Card>
          <Text className="mb-2 text-xs text-muted">
            Header (case-insensitive, optional):{"\n"}
            <Text className="font-mono text-2xs">{EXPECTED_HEADER}</Text>
            {"\n\n"}
            <Text className="font-semibold">rowType</Text> is one of{" "}
            <Text className="font-mono">gift</Text>, <Text className="font-mono">ticket</Text>,{" "}
            <Text className="font-mono">contact</Text>, or{" "}
            <Text className="font-mono">recurring</Text>. Only mission giving (nothing of
            value given back) should be <Text className="font-mono">gift</Text> —
            event-ticket buyers are <Text className="font-mono">ticket</Text> rows; they
            become contacts with purchase history, never donors.{" "}
            <Text className="font-semibold">amount</Text>/
            <Text className="font-semibold">recurringMonthly</Text> are dollars;{" "}
            <Text className="font-semibold">date</Text> is any parseable date (blank = now).
          </Text>
          <TextField
            label="Rows"
            value={text}
            onChangeText={setText}
            multiline
            numberOfLines={8}
            placeholder={"gift,Ada Lovelace,ada@example.com,,50,2026-01-05,givebutter,gb_txn_1,,"}
          />
          {gbParse ? (
            <Text className="mb-2 text-xs text-success">
              Detected a Givebutter transactions export · {gbParse.rows.length} row
              {gbParse.rows.length === 1 ? "" : "s"} across {gbParse.campaigns.length}{" "}
              campaign{gbParse.campaigns.length === 1 ? "" : "s"}. Map each campaign below.
            </Text>
          ) : null}
          <Button title="Preview" onPress={runPreview} disabled={!text.trim()} />
          {parseSkipped > 0 ? (
            <Text className="mt-2 text-xs text-warn">
              {parseSkipped} line{parseSkipped === 1 ? "" : "s"} skipped — missing a valid
              rowType or a name.
            </Text>
          ) : null}
        </Card>

        {gbParse && gbParse.campaigns.length > 0 ? (
          <View className="mb-4">
            <SectionHeader title="Map campaigns" />
            <Card>
              <Text className="mb-2 text-xs text-muted">
                For each Givebutter campaign, choose whether its transactions are mission{" "}
                <Text className="font-semibold">gifts</Text> (creates donors + giving
                history), event <Text className="font-semibold">tickets</Text> (contacts
                only, never donors), or <Text className="font-semibold">skip</Text>. Rows
                with a Refund Date are always skipped; a monthly frequency imports as a
                recurring pledge.
              </Text>
              {gbParse.campaigns.map((campaign) => {
                const current = gbMapping[campaign] ?? "skip";
                return (
                  <View key={campaign} className="mb-3">
                    <Text className="mb-1 text-sm text-ink" numberOfLines={1}>
                      {campaign}
                    </Text>
                    <View className="flex-row gap-2">
                      {(["gift", "ticket", "skip"] as GbRowKind[]).map((kind) => (
                        <Pill
                          key={kind}
                          label={kind}
                          selected={current === kind}
                          onPress={() =>
                            setGbMapping((m) => ({ ...m, [campaign]: kind }))
                          }
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
            </Card>
          </View>
        ) : null}

        {preview === undefined && previewArgs !== "skip" ? (
          <View className="items-center justify-center py-10">
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : null}

        {preview ? (
          <>
            <View className="my-4">
              <SectionHeader title="Summary" />
              <View className="flex-row flex-wrap gap-3">
                <Stat label="Rows" value={String(preview.summary.totalRows)} />
                <Stat
                  label="Gift rows"
                  value={String(preview.summary.giftRowCount)}
                  tone={
                    preview.summary.ticketRowCount > preview.summary.giftRowCount
                      ? "warn"
                      : "neutral"
                  }
                />
                <Stat label="Ticket rows" value={String(preview.summary.ticketRowCount)} />
                <Stat label="Contact rows" value={String(preview.summary.contactRowCount)} />
                <Stat label="Recurring rows" value={String(preview.summary.recurringRowCount)} />
                <Stat
                  label="Total gift $"
                  value={formatCents(preview.summary.totalGiftCents)}
                />
              </View>
              {preview.summary.ticketRowCount > 0 && preview.summary.giftRowCount > 0 ? (
                <Text className="mt-2 text-xs text-muted">
                  {preview.summary.giftRowCount} gift row
                  {preview.summary.giftRowCount === 1 ? "" : "s"} ·{" "}
                  {preview.summary.ticketRowCount} ticket row
                  {preview.summary.ticketRowCount === 1 ? "" : "s"} — ticket buyers become
                  contacts only, never donors. If this split looks backwards, check the
                  rowType column before committing.
                </Text>
              ) : null}
            </View>

            <View className="mb-4">
              <SectionHeader title={`Preview (${preview.rows.length})`} />
              <Table>
                <TableHeader>
                  <HeaderCell flex={2}>Row</HeaderCell>
                  <HeaderCell>Match</HeaderCell>
                  <HeaderCell flex={2}>Disposition</HeaderCell>
                </TableHeader>
                {preview.rows.map((r, i) => (
                  <Row key={r.index} last={i === preview.rows.length - 1}>
                    <Cell flex={2}>
                      <Text className="text-sm text-ink">
                        #{r.index + 1} · {r.rowType}
                      </Text>
                      {r.reason ? (
                        <Text className="text-2xs text-muted" numberOfLines={2}>
                          {r.reason}
                        </Text>
                      ) : null}
                    </Cell>
                    <Cell>
                      <Text className="text-xs text-muted">{r.donorMatch}</Text>
                    </Cell>
                    <Cell flex={2}>
                      <Badge label={r.disposition} tone={dispositionTone(r.disposition)} />
                    </Cell>
                  </Row>
                ))}
              </Table>
            </View>

            {suspectedRows.length > 0 ? (
              <View className="mb-4">
                <SectionHeader title={`Suspected duplicates (${suspectedRows.length})`} />
                <Card>
                  <Text className="mb-2 text-xs text-muted">
                    Same donor, same amount, within 24h of a gift already on record. Skipped
                    on commit unless included below.
                  </Text>
                  {suspectedRows.map((r) => (
                    <Text key={r.index} className="mb-1 text-xs text-ink">
                      #{r.index + 1} — {r.reason}
                    </Text>
                  ))}
                  <Pill
                    label={
                      allowSuspected
                        ? "Include suspected duplicates ✓"
                        : "Include suspected duplicates"
                    }
                    selected={allowSuspected}
                    onPress={() => setAllowSuspected((v) => !v)}
                  />
                </Card>
              </View>
            ) : null}

            <Card>
              {commitError ? (
                <Text className="mb-2 text-sm text-danger">{commitError}</Text>
              ) : null}
              {commitResult ? (
                <View className="mb-2">
                  <Text className="text-sm text-success">
                    Imported {commitResult.imported.gifts} gift
                    {commitResult.imported.gifts === 1 ? "" : "s"},{" "}
                    {commitResult.imported.pledges} pledge
                    {commitResult.imported.pledges === 1 ? "" : "s"},{" "}
                    {commitResult.imported.people} new contact
                    {commitResult.imported.people === 1 ? "" : "s"}
                    {commitResult.ticketHistoryLinked > 0
                      ? ` · ${commitResult.ticketHistoryLinked} ticket history linked`
                      : ""}
                    .
                  </Text>
                  <Text className="text-xs text-muted">
                    Skipped: {commitResult.skippedDuplicates} duplicate,{" "}
                    {commitResult.skippedSuspected} suspected,{" "}
                    {commitResult.skippedInvalid} invalid.
                    {commitResult.scheduledRemaining > 0
                      ? ` ${commitResult.scheduledRemaining} more row${
                          commitResult.scheduledRemaining === 1 ? "" : "s"
                        } scheduled to continue in the background.`
                      : ""}
                  </Text>
                </View>
              ) : null}
              <Button
                title="Commit import"
                onPress={runCommit}
                loading={committing}
                disabled={preview.rows.length === 0}
              />
            </Card>
          </>
        ) : null}
      </Narrow>
    </Screen>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <View className="min-w-[110px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text
        className={`mt-1 text-lg font-bold ${tone === "warn" ? "text-warn" : "text-ink"}`}
      >
        {value}
      </Text>
    </View>
  );
}
