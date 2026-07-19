/**
 * Import attendance — paste a guest-list export (Partiful guests, the hand-kept
 * payment spreadsheet, or a Givebutter ticket export), auto-detect its shape,
 * preview how each row will land on THIS event's guest list, then commit.
 *
 * This is the attendance sibling of the Giving import screen. It only ever
 * writes `rsvps` rows for this event — it never creates a donor or a roster
 * person. Most source data is name-only (no email/phone), which is why an
 * imported guest can be a bare name.
 *
 * CSV NOTE — this file uses a small QUOTE-AWARE line splitter, a deliberate
 * deviation from the naive `line.split(",")` the Giving import (and every other
 * paste importer in this app) uses: Partiful wraps any guest name that
 * contains a comma in double quotes (e.g. `"Smith, Jr.",Going,…`), so a naive
 * split would shear those names in half and misalign every following column.
 * The splitter handles `"…"` fields and `""` escaped quotes, but NOT quoted
 * fields that span multiple physical lines (each line is parsed on its own).
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Cell,
  HeaderCell,
  Row,
  SectionHeader,
  Table,
  TableHeader,
  TextField,
} from "../../ui";

type AttendanceRow = FunctionArgs<
  typeof api.eventAttendanceImport.previewAttendanceImport
>["rows"][number];

type ImportFormat = "partiful" | "spreadsheet" | "givebutter" | "unknown";

const FORMAT_LABEL: Record<ImportFormat, string> = {
  partiful: "Partiful guest list",
  spreadsheet: "Payment spreadsheet",
  givebutter: "Givebutter ticket export",
  unknown: "Unrecognized",
};

// ── CSV parsing (quote-aware; see file header) ───────────────────────────────

/** Split ONE physical line into trimmed cells, honoring `"…"` quoted fields
 *  (which may contain commas) and `""` escaped quotes inside them. */
function splitCsvLine(line: string): string[] {
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
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Index of a header cell by case-insensitive exact name, or -1. */
function headerIndex(headers: string[], name: string): number {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === target);
}

function has(headers: string[], name: string): boolean {
  return headerIndex(headers, name) >= 0;
}

function detectFormat(headers: string[]): ImportFormat {
  if (has(headers, "Ticket Number")) return "givebutter";
  if (has(headers, "Verified Payment") && has(headers, "Platform")) return "spreadsheet";
  if (has(headers, "Status") && (has(headers, "Is Plus One Of") || has(headers, "RSVP date"))) {
    return "partiful";
  }
  return "unknown";
}

type ParseResult = {
  format: ImportFormat;
  rows: AttendanceRow[];
  skipped: number; // invited/error rows dropped client-side, never sent
};

const EMPTY: ParseResult = { format: "unknown", rows: [], skipped: 0 };

function parseDate(raw?: string): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function pushNote(parts: string[], value?: string) {
  const v = value?.trim();
  if (v) parts.push(v);
}

/** Partiful: Name, Status, RSVP date, [custom…], Is Plus One Of. */
function parsePartiful(headers: string[], lines: string[][]): ParseResult {
  const iName = headerIndex(headers, "Name");
  const iStatus = headerIndex(headers, "Status");
  const iDate = headerIndex(headers, "RSVP date");
  const iPlus = headerIndex(headers, "Is Plus One Of");
  const rows: AttendanceRow[] = [];
  let skipped = 0;
  for (const cells of lines) {
    const name = (cells[iName] ?? "").trim();
    if (!name) continue;
    const statusRaw = (cells[iStatus] ?? "").trim().toLowerCase();
    let status: AttendanceRow["status"];
    if (statusRaw === "going" || statusRaw === "approved") status = "going";
    else if (statusRaw === "maybe" || statusRaw === "pending" || statusRaw === "interested")
      status = "maybe";
    else if (statusRaw === "can't go" || statusRaw === "can't come") status = "not_going";
    else if (statusRaw === "invited" || statusRaw === "error") {
      skipped++;
      continue;
    } else status = "going";
    const plusOneOf = iPlus >= 0 ? (cells[iPlus] ?? "").trim() : "";
    const respondedAt = iDate >= 0 ? parseDate(cells[iDate]) : undefined;
    rows.push({
      name,
      status,
      ...(plusOneOf ? { plusOneOf } : {}),
      ...(respondedAt !== undefined ? { respondedAt } : {}),
    });
  }
  return { format: "partiful", rows, skipped };
}

/** Split a Givebutter "<phone> / <email>" username field into phone/email. */
function splitGivebutterHandle(raw?: string): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  for (const part of (raw ?? "").split("/")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("@")) out.email = p.toLowerCase();
    else {
      const digits = p.replace(/\D/g, "");
      if (digits.length >= 10) out.phone = digits;
    }
  }
  return out;
}

/** Payment spreadsheet: col 0 = Name (header often corrupted), then Status,
 *  Verified Payment, Platform, Cashapp/Venmo Username, RSVP date, Gender,
 *  Is Plus One Of, Notes. */
function parseSpreadsheet(headers: string[], lines: string[][]): ParseResult {
  const iStatus = headerIndex(headers, "Status");
  const iPlatform = headerIndex(headers, "Platform");
  const iHandle = headerIndex(headers, "Cashapp/Venmo Username");
  const iDate = headerIndex(headers, "RSVP date");
  const iGender = headerIndex(headers, "Gender");
  const iPlus = headerIndex(headers, "Is Plus One Of");
  const iNotes = headerIndex(headers, "Notes");
  const rows: AttendanceRow[] = [];
  let skipped = 0;
  for (const cells of lines) {
    const name = (cells[0] ?? "").trim(); // column 0 is always the name
    if (!name) continue;
    const statusRaw = (cells[iStatus] ?? "").trim().toLowerCase();
    let status: AttendanceRow["status"] = "going";
    const noteParts: string[] = [];
    if (statusRaw === "going") status = "going";
    else if (statusRaw === "can't come" || statusRaw === "can't go") status = "not_going";
    else if (statusRaw === "maybe" || statusRaw === "pending" || statusRaw === "interested")
      status = "maybe";
    else if (statusRaw === "panelist") {
      status = "going";
      noteParts.push("Panelist");
    } else if (statusRaw === "not on partiful") status = "going";
    else if (statusRaw === "invited" || statusRaw === "error") {
      skipped++;
      continue;
    }

    const platform = iPlatform >= 0 ? (cells[iPlatform] ?? "").trim() : "";
    const handle = iHandle >= 0 ? (cells[iHandle] ?? "").trim() : "";
    const platformLower = platform.toLowerCase();
    let email: string | undefined;
    let phone: string | undefined;
    let wasTicketHolder = false;

    if (platformLower.startsWith("givebutter")) {
      // "Givebutter - Ticket" / "Givebutter - Donation": the handle field is
      // actually "<phone> / <email>".
      const parsed = splitGivebutterHandle(handle);
      email = parsed.email;
      phone = parsed.phone;
      wasTicketHolder = platformLower.includes("ticket");
      pushNote(noteParts, platform);
    } else if (
      platformLower === "cashapp" ||
      platformLower === "venmo" ||
      platformLower === "zelle"
    ) {
      // Paid off-platform — they still bought in. Keep the handle as a note.
      wasTicketHolder = true;
      pushNote(noteParts, handle ? `${platform} ${handle}` : platform);
    } else if (platform) {
      pushNote(noteParts, handle ? `${platform} ${handle}` : platform);
    }

    if (iGender >= 0) pushNote(noteParts, cells[iGender]);
    if (iNotes >= 0) pushNote(noteParts, cells[iNotes]);
    const note = noteParts.join(" · ") || undefined;
    const plusOneOf = iPlus >= 0 ? (cells[iPlus] ?? "").trim() : "";
    const respondedAt = iDate >= 0 ? parseDate(cells[iDate]) : undefined;

    rows.push({
      name,
      status,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(wasTicketHolder ? { wasTicketHolder } : {}),
      ...(note ? { note } : {}),
      ...(plusOneOf ? { plusOneOf } : {}),
      ...(respondedAt !== undefined ? { respondedAt } : {}),
    });
  }
  return { format: "spreadsheet", rows, skipped };
}

/** Givebutter ticket export: First/Last → name, Email, Phone, ticket note. */
function parseGivebutter(headers: string[], lines: string[][]): ParseResult {
  const iFirst = headerIndex(headers, "First Name");
  const iLast = headerIndex(headers, "Last Name");
  const iEmail = headerIndex(headers, "Email");
  const iPhone = headerIndex(headers, "Phone");
  const iType = headerIndex(headers, "Ticket Type");
  const iPrice = headerIndex(headers, "Price");
  const iDate = headerIndex(headers, "Date (UTC)");
  const rows: AttendanceRow[] = [];
  for (const cells of lines) {
    const name = [cells[iFirst], cells[iLast]]
      .map((c) => (c ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (!name) continue;
    const email = iEmail >= 0 ? (cells[iEmail] ?? "").trim().toLowerCase() : "";
    const phoneDigits = iPhone >= 0 ? (cells[iPhone] ?? "").replace(/\D/g, "") : "";
    const noteParts: string[] = [];
    if (iType >= 0) pushNote(noteParts, cells[iType]);
    if (iPrice >= 0) pushNote(noteParts, cells[iPrice]);
    const note = noteParts.join("; ") || undefined;
    const respondedAt = iDate >= 0 ? parseDate(cells[iDate]) : undefined;
    rows.push({
      name,
      status: "going", // every ticket row is an attendee
      wasTicketHolder: true,
      ...(email ? { email } : {}),
      ...(phoneDigits.length >= 10 ? { phone: phoneDigits } : {}),
      ...(note ? { note } : {}),
      ...(respondedAt !== undefined ? { respondedAt } : {}),
    });
  }
  return { format: "givebutter", rows, skipped: 0 };
}

function parseAttendance(text: string): ParseResult {
  const physical = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (physical.length < 1) return EMPTY;
  const headers = splitCsvLine(physical[0]);
  const format = detectFormat(headers);
  if (format === "unknown") return { ...EMPTY, format };
  const body = physical.slice(1).map(splitCsvLine);
  if (format === "partiful") return parsePartiful(headers, body);
  if (format === "spreadsheet") return parseSpreadsheet(headers, body);
  return parseGivebutter(headers, body);
}

// ── Disposition badges ───────────────────────────────────────────────────────

function dispositionTone(disposition: string): BadgeTone {
  if (disposition === "new") return "success";
  if (disposition === "update") return "info";
  if (disposition === "duplicate") return "neutral";
  return "danger"; // invalid
}

// ── Component ────────────────────────────────────────────────────────────────

export function ImportAttendanceCard({ eventId }: { eventId: Id<"events"> }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [previewArgs, setPreviewArgs] = useState<
    { eventId: Id<"events">; rows: AttendanceRow[] } | "skip"
  >("skip");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<{
    inserted: number;
    updated: number;
    skippedDuplicates: number;
    skippedInvalid: number;
    scheduledRemaining: number;
  } | null>(null);

  const preview = useQuery(
    api.eventAttendanceImport.previewAttendanceImport,
    previewArgs === "skip" ? "skip" : previewArgs,
  );
  const commit = useMutation(api.eventAttendanceImport.commitAttendanceImport);

  function runPreview() {
    setCommitResult(null);
    setCommitError(null);
    const result = parseAttendance(text);
    setParsed(result);
    if (result.rows.length === 0) {
      setPreviewArgs("skip");
      return;
    }
    setPreviewArgs({ eventId, rows: result.rows });
  }

  async function runCommit() {
    if (previewArgs === "skip") return;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await commit({ eventId, rows: previewArgs.rows });
      setCommitResult(result);
    } catch {
      setCommitError("Couldn't import — check the format and try again.");
    } finally {
      setCommitting(false);
    }
  }

  const rowsById = useMemo(
    () => new Map((preview?.rows ?? []).map((r) => [r.index, r] as const)),
    [preview],
  );

  return (
    <Card>
      <Text className="mb-2 text-xs text-muted">
        Paste a Partiful guest export, the payment spreadsheet, or a Givebutter
        ticket export. The format is auto-detected. Invited/Error rows are
        skipped. This only adds people to THIS event's guest list — it never
        creates donors or roster contacts.
      </Text>
      <TextField
        label="Paste rows (with the header line)"
        value={text}
        onChangeText={setText}
        multiline
        numberOfLines={8}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={"Name,Status,RSVP date,Is Plus One Of\nAda,Going,2026-01-05,"}
      />
      <Button title="Preview" onPress={runPreview} disabled={!text.trim()} />

      {parsed && parsed.format === "unknown" ? (
        <Text className="mt-2 text-xs text-danger">
          Couldn't recognize that header. Include the export's header row.
        </Text>
      ) : null}
      {parsed && parsed.format !== "unknown" ? (
        <Text className="mt-2 text-xs text-muted">
          Detected: {FORMAT_LABEL[parsed.format]} · {parsed.rows.length} row
          {parsed.rows.length === 1 ? "" : "s"}
          {parsed.skipped > 0
            ? ` · ${parsed.skipped} invited/error row${parsed.skipped === 1 ? "" : "s"} skipped`
            : ""}
        </Text>
      ) : null}

      {preview ? (
        <View className="mt-4">
          <SectionHeader title="Preview" />
          <View className="mb-2 flex-row flex-wrap gap-3">
            <Stat label="New" value={String(preview.summary.newCount)} />
            <Stat label="Update" value={String(preview.summary.updateCount)} />
            <Stat label="Duplicate" value={String(preview.summary.duplicateCount)} />
            <Stat
              label="Invalid"
              value={String(preview.summary.invalidCount)}
              tone={preview.summary.invalidCount > 0 ? "warn" : "neutral"}
            />
          </View>
          <Text className="mb-2 text-xs text-muted">
            Will set {preview.summary.wouldBeGoing} going,{" "}
            {preview.summary.wouldBeMaybe} maybe, {preview.summary.wouldBeNotGoing}{" "}
            not going. {preview.summary.emaillessCount} row
            {preview.summary.emaillessCount === 1 ? "" : "s"} have no email
            {preview.summary.emaillessCount > 0 ? " (unreachable by email blast)" : ""}.
          </Text>

          {preview.summary.nameCollisions.length > 0 ? (
            <View className="mb-2 rounded-md border border-warn/40 bg-warn/10 p-3">
              <Text className="text-xs font-semibold text-warn">
                Name collisions — dedup by name is ambiguous for:
              </Text>
              <Text className="text-xs text-muted">
                {preview.summary.nameCollisions.join(", ")}
              </Text>
            </View>
          ) : null}

          <Table>
            <TableHeader>
              <HeaderCell flex={2}>Guest</HeaderCell>
              <HeaderCell>Match</HeaderCell>
              <HeaderCell>Disposition</HeaderCell>
            </TableHeader>
            {(previewArgs === "skip" ? [] : previewArgs.rows).map((row, i) => {
              const r = rowsById.get(i);
              if (!r) return null;
              return (
                <Row key={i} last={i === (previewArgs === "skip" ? 0 : previewArgs.rows.length - 1)}>
                  <Cell flex={2}>
                    <Text className="text-sm text-ink" numberOfLines={1}>
                      {row.name || "—"}
                    </Text>
                    {r.reason ? (
                      <Text className="text-2xs text-muted" numberOfLines={2}>
                        {r.reason}
                      </Text>
                    ) : null}
                  </Cell>
                  <Cell>
                    <Text className="text-xs text-muted">{r.matchedBy ?? "—"}</Text>
                  </Cell>
                  <Cell>
                    <Badge label={r.disposition} tone={dispositionTone(r.disposition)} />
                  </Cell>
                </Row>
              );
            })}
          </Table>

          <View className="mt-3">
            {commitError ? (
              <Text className="mb-2 text-sm text-danger">{commitError}</Text>
            ) : null}
            {commitResult ? (
              <Text className="mb-2 text-sm text-success">
                Imported {commitResult.inserted} new,{" "}
                {commitResult.updated} updated,{" "}
                {commitResult.skippedDuplicates} unchanged,{" "}
                {commitResult.skippedInvalid} invalid.
                {commitResult.scheduledRemaining > 0
                  ? ` ${commitResult.scheduledRemaining} more continuing in the background.`
                  : ""}
              </Text>
            ) : null}
            <Button
              title="Commit import"
              onPress={runCommit}
              loading={committing}
              disabled={preview.rows.length === 0}
            />
          </View>
        </View>
      ) : null}
    </Card>
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
    <View className="min-w-[72px] flex-1 rounded-lg border border-border bg-raised p-2">
      <Text className="text-2xs text-muted">{label}</Text>
      <Text
        className={`mt-0.5 text-lg font-bold ${tone === "warn" ? "text-warn" : "text-ink"}`}
      >
        {value}
      </Text>
    </View>
  );
}
