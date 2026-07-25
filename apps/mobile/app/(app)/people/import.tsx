/**
 * PEOPLE → IMPORT CONTACTS (founder ask, 2026-07-25: "the import should be in
 * people, not giving") — bulk contact onboarding for the roster's Contacts
 * list. Paste either:
 *   - a Givebutter CONTACTS export (auto-detected by its own headers —
 *     `lib/givebutterContacts.ts`; names stay pre-split, Preferred First
 *     wins, phones normalize), or
 *   - plain lines of `name,email,phone` (header optional).
 *
 * Two-phase like every import in this app: PREVIEW (read-only — new vs.
 * matched vs. no-identifier, so a re-paste shows "251 matched, 0 new" instead
 * of silently double-creating) → IMPORT (committed in chunks of
 * `CHUNK` rows per mutation call, sequential, with progress — the backend
 * enforces the same cap; see `peopleImport.ts`'s read-budget doc).
 *
 * This screen creates CONTACTS ONLY — never donors, never giving history.
 * Money-bearing files (gifts/tickets/recurring) still import through
 * Giving → Import, which is gated by giving-manage power; this one is gated
 * like the People grid itself (chapter membership).
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  TextField,
} from "../../../components/ui";
import {
  parseGivebutterContacts,
  type GivebutterContact,
} from "../../../lib/givebutterContacts";

type ContactRow = FunctionArgs<typeof api.peopleImport.importContacts>["rows"][number];

/** Matches `peopleImport.ts#CONTACTS_IMPORT_BATCH_LIMIT` — the backend
 *  rejects anything larger, so this stays in lockstep by being ≤ it. */
const CHUNK = 100;

/** Plain-lines fallback: `name,email,phone` per line (quotes not needed —
 *  this path is for quick hand-made lists; the Givebutter path handles real
 *  CSV quoting). A header line starting with "name" is skipped. */
function parsePlainLines(text: string): ContactRow[] {
  const rows: ContactRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name = "", email = "", phone = ""] = line.split(",").map((c) => c.trim());
    if (name.toLowerCase() === "name") continue; // header
    const phoneDigits = phone.replace(/\D/g, "");
    if (!name && !email) continue;
    rows.push({
      name: name || email.split("@")[0],
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(phoneDigits.length >= 10 ? { phone: phoneDigits } : {}),
    });
  }
  return rows;
}

function contactToRow(c: GivebutterContact): ContactRow {
  return {
    name: c.name,
    ...(c.firstName ? { firstName: c.firstName } : {}),
    ...(c.lastName ? { lastName: c.lastName } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
  };
}

export default function PeopleImportScreen() {
  const [text, setText] = useState("");
  const gb = useMemo(() => parseGivebutterContacts(text), [text]);
  const rows = useMemo<ContactRow[]>(
    () => (gb ? gb.contacts.map(contactToRow) : parsePlainLines(text)),
    [gb, text],
  );

  const [previewing, setPreviewing] = useState(false);
  // Preview covers the FIRST chunk exactly (the backend caps a call at the
  // same size); the totals line below extrapolates honestly by labeling
  // which rows were actually previewed.
  const preview = useQuery(
    api.peopleImport.previewContactsImport,
    previewing && rows.length > 0 ? { rows: rows.slice(0, CHUNK) } : "skip",
  );
  const commit = useMutation(api.peopleImport.importContacts);

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: number;
    matched: number;
    skippedNoIdentifier: number;
  } | null>(null);

  async function runImport() {
    setImporting(true);
    setError(null);
    setResult(null);
    const totals = { created: 0, matched: 0, skippedNoIdentifier: 0 };
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const r = await commit({ rows: rows.slice(i, i + CHUNK) });
        totals.created += r.created;
        totals.matched += r.matched;
        totals.skippedNoIdentifier += r.skippedNoIdentifier;
        setProgress(Math.min(rows.length, i + CHUNK));
      }
      setResult(totals);
    } catch {
      // Partial imports are safe to retry: match-or-create means a re-run
      // matches everything already created instead of duplicating it.
      setError(
        `Import stopped after ${totals.created + totals.matched} rows — check your connection and run it again (already-imported contacts are matched, never duplicated).`,
      );
      setResult(totals);
    } finally {
      setImporting(false);
      setProgress(0);
    }
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title="Import contacts" />
        <Card>
          <Text className="mb-2 text-xs text-muted">
            Paste a <Text className="font-semibold">Givebutter contacts export</Text> (the
            whole file — it's detected automatically, names and phones included) or plain
            lines of <Text className="font-mono text-2xs">name,email,phone</Text>. Everyone
            lands under People → Contacts; existing people are matched by email, phone, or
            exact name and never duplicated. Nothing financial is created here.
          </Text>
          <TextField
            label="Contacts"
            value={text}
            onChangeText={(t) => {
              setText(t);
              setPreviewing(false);
              setResult(null);
              setError(null);
            }}
            multiline
            numberOfLines={8}
            placeholder={"Ada Lovelace,ada@example.com,+1 555 010 1234"}
          />
          {gb ? (
            <Text className="mb-2 text-xs text-success">
              Detected a Givebutter contacts export · {gb.contacts.length} contact
              {gb.contacts.length === 1 ? "" : "s"}, first/last names included.
            </Text>
          ) : rows.length > 0 ? (
            <Text className="mb-2 text-xs text-muted">
              {rows.length} line{rows.length === 1 ? "" : "s"} ready.
            </Text>
          ) : null}
          {gb && gb.noIdentifier > 0 ? (
            <Text className="mb-2 text-xs text-warn">
              {gb.noIdentifier} row{gb.noIdentifier === 1 ? "" : "s"} have no email or phone —
              they'll be reported but never created.
            </Text>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              title="Preview"
              variant="secondary"
              onPress={() => setPreviewing(true)}
              disabled={rows.length === 0 || importing}
            />
            <Button
              title={importing ? `Importing… ${progress}/${rows.length}` : "Import"}
              onPress={runImport}
              loading={importing}
              disabled={rows.length === 0 || importing}
            />
          </View>
        </Card>

        {previewing && preview ? (
          <View className="mt-4">
            <SectionHeader title="Preview" />
            <Card>
              <View className="mb-2 flex-row flex-wrap gap-2">
                <Badge label={`${preview.newCount} new`} tone="success" />
                <Badge label={`${preview.matchedCount} already known`} tone="info" />
                {preview.noIdentifierCount > 0 ? (
                  <Badge label={`${preview.noIdentifierCount} no email/phone`} tone="warn" />
                ) : null}
              </View>
              <Text className="text-xs text-muted">
                {rows.length > CHUNK
                  ? `Previewing the first ${CHUNK} of ${rows.length} rows — the same matching applies to the rest on import.`
                  : "Nothing has been written yet — Import commits exactly what's shown."}
              </Text>
            </Card>
          </View>
        ) : null}

        {result ? (
          <View className="mt-4">
            <SectionHeader title="Done" />
            <Card>
              <View className="flex-row flex-wrap gap-2">
                <Badge label={`${result.created} added`} tone="success" />
                <Badge label={`${result.matched} already known`} tone="info" />
                {result.skippedNoIdentifier > 0 ? (
                  <Badge
                    label={`${result.skippedNoIdentifier} skipped (no email/phone)`}
                    tone="warn"
                  />
                ) : null}
              </View>
              <Text className="mt-2 text-xs text-muted">
                Find them under People → Contacts. They're all reachable by campaigns
                unless they unsubscribe (or were already on the unsubscribe list).
              </Text>
            </Card>
          </View>
        ) : null}

        {error ? (
          <View className="mt-4">
            <EmptyState icon="alert-triangle" title="Import interrupted" message={error} />
          </View>
        ) : null}
      </Narrow>
    </Screen>
  );
}
