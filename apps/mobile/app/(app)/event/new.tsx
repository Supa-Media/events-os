import { createElement, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  TextInput,
} from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Screen,
  Card,
  Button,
  Badge,
  TextField,
  EmptyState,
  SectionHeader,
  Field,
  LocationAutocomplete,
} from "../../../components/ui";
import { ScopeToggle, type ScopeChoice } from "../../../components/team/ScopeToggle";
import { colors, radius, spacing } from "../../../lib/theme";
import { parseDateTimeInput, formatDateTime } from "../../../lib/format";
import { MeridiemButton } from "../../../components/ui/DateTimeField";
import { errorMessage } from "../../../lib/errors";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { getCreateBlockReason } from "../../../components/event/newEventValidation";

/**
 * Sentinel for the ad-hoc "Blank event" card — not a real `eventTypes` id.
 * `handleCreate` omits `eventTypeId` entirely when this is selected;
 * `events.createFromTemplate` resolves it server-side to the chapter's
 * lazily-created blank template (see `getOrCreateBlankTemplate`).
 */
const BLANK_TEMPLATE_ID = "blank" as const;

/**
 * Date picker. On web this is the browser's native `<input type="date">` (real
 * calendar). On native — where the app ships no date-picker dependency — three
 * numeric fields (year / month / day) avoid the free-text typo trap of a single
 * `YYYY-MM-DD` box while staying dependency-free. Both paths emit a canonical
 * `YYYY-MM-DD` string so the timeline back-calculation downstream is unchanged.
 */
function DatePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  if (Platform.OS === "web") {
    return (
      <Field
        label="Date"
        hint="The whole task timeline is back-calculated from this date."
      >
        {createElement("input", {
          type: "date",
          value,
          "aria-label": "Event date",
          onChange: (e: any) => onChange(e.target.value),
          style: {
            font: "inherit",
            fontSize: 15,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: "10px 12px",
            background: colors.surface,
            outline: "none",
          },
        })}
      </Field>
    );
  }

  // Native: split the YYYY-MM-DD string into three editable numeric fields.
  const [y = "", m = "", d = ""] = value ? value.split("-") : [];
  const part = (pos: "y" | "m" | "d", next: string) => {
    const digits = next.replace(/[^0-9]/g, "");
    const ny = pos === "y" ? digits : y;
    const nm = pos === "m" ? digits : m;
    const nd = pos === "d" ? digits : d;
    // Emit "" when every sub-field is blank so the empty-date branch stays
    // reachable (otherwise "--" reads as a non-empty, "invalid" date).
    onChange(ny || nm || nd ? `${ny}-${nm}-${nd}` : "");
  };
  return (
    <Field
      label="Date"
      hint="The whole task timeline is back-calculated from this date."
    >
      <View style={styles.dateParts}>
        <TextInput
          style={[styles.datePart, styles.datePartWide]}
          placeholder="YYYY"
          placeholderTextColor={colors.faint}
          value={y}
          onChangeText={(t) => part("y", t)}
          keyboardType="number-pad"
          maxLength={4}
          accessibilityLabel="Event year"
        />
        <Text style={styles.dateSep}>-</Text>
        <TextInput
          style={styles.datePart}
          placeholder="MM"
          placeholderTextColor={colors.faint}
          value={m}
          onChangeText={(t) => part("m", t)}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Event month"
        />
        <Text style={styles.dateSep}>-</Text>
        <TextInput
          style={styles.datePart}
          placeholder="DD"
          placeholderTextColor={colors.faint}
          value={d}
          onChangeText={(t) => part("d", t)}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Event day"
        />
      </View>
    </Field>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Parse a canonical "HH:mm" (24h) string into 12-hour parts, or null. */
function parseHHMM(v: string): { h12: number; min: number; pm: boolean } | null {
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h12: h % 12 === 0 ? 12 : h % 12, min, pm: h >= 12 };
}

/** Build a canonical "HH:mm" (24h) string from 12-hour parts. */
function toHHMM(h12: number, min: number, pm: boolean): string {
  return `${pad2((h12 % 12) + (pm ? 12 : 0))}:${pad2(min)}`;
}

/**
 * Start-time picker, paired with {@link DatePickerField}. On web this is the
 * browser's native `<input type="time">`; on native it's a typed hour : minute
 * pair plus the app's AM·PM chips (the same aesthetic as the run-of-show time
 * cell). Both paths emit a canonical `HH:mm` (24h) string — combined with the
 * date, this is the event start anchor. REQUIRED: emits "" until fully entered
 * so the form can block submit (the old form defaulted to midnight — the bug).
 */
function TimePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  if (Platform.OS === "web") {
    return (
      <Field
        label="Start time"
        hint="Every run-of-show time is derived from this start."
      >
        {createElement("input", {
          type: "time",
          value,
          "aria-label": "Event start time",
          onChange: (e: any) => onChange(e.target.value),
          style: {
            font: "inherit",
            fontSize: 15,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: "10px 12px",
            background: colors.surface,
            outline: "none",
          },
        })}
      </Field>
    );
  }
  return <NativeTimeField value={value} onChange={onChange} />;
}

/** Native hour : minute + AM·PM entry. Local draft state, seeded once. */
function NativeTimeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const seed = parseHHMM(value);
  const [hourText, setHourText] = useState(seed ? pad2(seed.h12) : "");
  const [minText, setMinText] = useState(seed ? pad2(seed.min) : "");
  const [isPm, setIsPm] = useState(seed?.pm ?? false);

  // Emit a canonical time only when BOTH fields are filled and valid; otherwise
  // emit "" so the required-time submit guard stays reachable.
  const emit = (h: string, m: string, pm: boolean) => {
    if (h.trim() === "" || m.trim() === "") return onChange("");
    const hn = parseInt(h, 10);
    const mn = parseInt(m, 10);
    if (!Number.isFinite(hn) || !Number.isFinite(mn)) return onChange("");
    const h12 = Math.min(12, Math.max(1, hn));
    const min = Math.min(59, Math.max(0, mn));
    onChange(toHHMM(h12, min, pm));
  };

  return (
    <Field
      label="Start time"
      hint="Every run-of-show time is derived from this start."
    >
      <View style={styles.timeParts}>
        <TextInput
          style={styles.datePart}
          placeholder="HH"
          placeholderTextColor={colors.faint}
          value={hourText}
          onChangeText={(t) => {
            const digits = t.replace(/[^0-9]/g, "");
            setHourText(digits);
            emit(digits, minText, isPm);
          }}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Start hour"
        />
        <Text style={styles.dateSep}>:</Text>
        <TextInput
          style={styles.datePart}
          placeholder="MM"
          placeholderTextColor={colors.faint}
          value={minText}
          onChangeText={(t) => {
            const digits = t.replace(/[^0-9]/g, "");
            setMinText(digits);
            emit(hourText, digits, isPm);
          }}
          keyboardType="number-pad"
          maxLength={2}
          accessibilityLabel="Start minute"
        />
        <View style={styles.meridiem}>
          <MeridiemButton
            label="AM"
            active={!isPm}
            onPress={() => {
              setIsPm(false);
              emit(hourText, minText, false);
            }}
          />
          <MeridiemButton
            label="PM"
            active={isPm}
            onPress={() => {
              setIsPm(true);
              emit(hourText, minText, true);
            }}
          />
        </View>
      </View>
    </Field>
  );
}

/** NEW EVENT: pick a template, name it, set a date + start time, create. */
export default function NewEventScreen() {
  const router = useRouter();
  const { templateId, date: dateParam } = useLocalSearchParams<{
    templateId?: string;
    date?: string;
  }>();
  const templates = useQuery(api.templates.list);
  type TemplateRow = NonNullable<typeof templates>[number];
  const create = useMutation(api.events.createFromTemplate);
  // Creation-time money-attribution picker (owner spec: "creator's highest
  // hat" default, editable) — mirrors `projects.create`'s picker exactly.
  // `isCentral` is false for every caller without central WRITE reach, so a
  // chapter-only creator never sees this field; `createFromTemplate` still
  // resolves the same default server-side for them.
  const scopeOptions = useQuery(api.events.scopeOptions);
  const [scope, setScope] = useState<ScopeChoice>("chapter");
  // Re-sync to the resolved default whenever it changes (e.g. once the query
  // loads) — never overwrites an explicit user pick mid-form, only the
  // initial unset state.
  const [scopeTouched, setScopeTouched] = useState(false);
  useEffect(() => {
    if (!scopeTouched && scopeOptions?.defaultScope) setScope(scopeOptions.defaultScope);
  }, [scopeTouched, scopeOptions?.defaultScope]);

  const [selectedId, setSelectedId] = useState<
    Id<"eventTypes"> | typeof BLANK_TEMPLATE_ID | null
  >((templateId as Id<"eventTypes"> | undefined) ?? null);
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  // Prefill from a `?date=YYYY-MM-DD` deep-link (e.g. tapping an open day on the
  // calendar); fall back to empty so the picker opens unset otherwise.
  const [date, setDate] = useState(
    typeof dateParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : "",
  );
  // Canonical "HH:mm" (24h) start time — required. Empty until the user sets it
  // so submit stays blocked (the old form silently defaulted to midnight).
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (templates === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: "New event" }} />
        <Screen loading />
      </>
    );
  }

  const selected =
    selectedId && selectedId !== BLANK_TEMPLATE_ID
      ? templates.find((t) => t._id === selectedId) ?? null
      : null;
  // Default the name to the template name until the user types their own —
  // Blank has no template to borrow a name from, so it starts empty.
  const effectiveName = touchedName ? name : selected?.name ?? "";
  const parsedDateTime =
    date && time ? parseDateTimeInput(date, time) : null;
  const blockReason = getCreateBlockReason({
    selectedId,
    effectiveName,
    date,
    time,
  });

  function pickTemplate(t: TemplateRow) {
    setSelectedId(t._id);
    if (!touchedName) setName("");
  }

  function pickBlank() {
    setSelectedId(BLANK_TEMPLATE_ID);
    if (!touchedName) setName("");
  }

  async function handleCreate() {
    setError(null);
    if (blockReason) {
      setError(blockReason);
      return;
    }
    const finalName = effectiveName.trim();
    const ts = parseDateTimeInput(date, time)!;
    setCreating(true);
    try {
      const id = await create({
        // Omitted for the Blank card — `createFromTemplate` resolves the
        // chapter's ad-hoc blank template server-side (see
        // `getOrCreateBlankTemplate`).
        eventTypeId:
          selectedId && selectedId !== BLANK_TEMPLATE_ID ? selectedId : undefined,
        name: finalName,
        eventDate: ts,
        location: location.trim() || undefined,
        // Only override the server's own default when the picker is actually
        // shown (central-capable caller) — everyone else's create call omits
        // `scope` entirely, so `createFromTemplate` resolves its own default.
        ...(scopeOptions?.isCentral ? { scope } : {}),
      });
      router.replace(`/event/${id}`);
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the event."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "New event" }} />
      <Screen>
        <SectionHeader title="Template" />
        <View style={styles.templateList}>
          {/* Ad-hoc path (owner spec: "I shouldn't need [a template] for an
              event I'm planning on the fly") — always offered, even when the
              chapter has zero named templates, so creation is never blocked
              on template management. */}
          {(() => {
            const blankActive = selectedId === BLANK_TEMPLATE_ID;
            return (
              <Pressable
                onPress={pickBlank}
                style={[styles.templateRow, blankActive && styles.templateActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: blankActive }}
              >
                <View style={styles.templateText}>
                  <Text style={styles.templateName}>Blank event</Text>
                  <Text style={styles.templateMeta}>
                    Start from scratch — no pre-filled tasks or roles
                  </Text>
                </View>
                {blankActive ? <Badge label="Selected" tone="accent" /> : null}
              </Pressable>
            );
          })()}
          {templates.map((t: TemplateRow) => {
            const active = t._id === selectedId;
            return (
              <Pressable
                key={t._id}
                onPress={() => pickTemplate(t)}
                style={[styles.templateRow, active && styles.templateActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <View style={styles.templateText}>
                  <Text style={styles.templateName}>{t.name}</Text>
                  <Text style={styles.templateMeta}>
                    {t.roles.length} roles · {t.taskCount} tasks
                  </Text>
                </View>
                {active ? <Badge label="Selected" tone="accent" /> : null}
              </Pressable>
            );
          })}
        </View>
        {templates.length === 0 ? (
          <EmptyState
            title="No named templates yet"
            message="Blank event above works for a one-off — or create a reusable template."
            action={
              <Button
                title="Go to Templates"
                variant="secondary"
                onPress={() => router.replace("/templates")}
              />
            }
          />
        ) : null}

        <SectionHeader title="Details" />
        <Card>
          <TextField
            label="Event name"
            placeholder={selected?.name ?? "Name"}
            value={effectiveName}
            onChangeText={(v) => {
              setTouchedName(true);
              setName(v);
            }}
          />
          <DatePickerField value={date} onChange={setDate} />
          <TimePickerField value={time} onChange={setTime} />
          {parsedDateTime !== null ? (
            <Text style={styles.dateConfirm}>
              {formatDateTime(parsedDateTime)}
            </Text>
          ) : null}
          <LocationAutocomplete
            label="Location (optional)"
            placeholder="Where is it?"
            value={location}
            onChangeText={setLocation}
          />
          {scopeOptions?.isCentral ? (
            <Field
              label="Belongs to"
              hint="Money attribution — editable later from the event's Money tab."
            >
              <ScopeToggle
                value={scope}
                chapterName={scopeOptions.chapterName}
                onChange={(next) => {
                  setScopeTouched(true);
                  setScope(next);
                }}
              />
            </Field>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            title="Create event"
            onPress={handleCreate}
            loading={creating}
            disabled={!!blockReason}
          />
          {/* Never leave a dead grey button unexplained (live-blocker
              postmortem) — the reason always matches the disabled check
              above, both driven by `getCreateBlockReason`. Suppressed once an
              `error` is already showing (e.g. a submit failure) to avoid two
              overlapping one-liners. */}
          {blockReason && !error ? (
            <Text style={styles.blockReason}>{blockReason}</Text>
          ) : null}
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  templateList: { gap: spacing.sm },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  templateActive: { borderColor: colors.accent, backgroundColor: colors.accentBg },
  templateText: { flex: 1, gap: 2 },
  templateName: { fontSize: 15, fontWeight: "600", color: colors.text },
  templateMeta: { fontSize: 13, color: colors.muted },
  error: { color: colors.danger, fontSize: 13, marginBottom: spacing.sm },
  blockReason: {
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  dateParts: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  timeParts: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  meridiem: { flexDirection: "row", gap: spacing.xs, marginLeft: spacing.xs },
  datePart: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    minWidth: 56,
  },
  datePartWide: { minWidth: 84 },
  dateSep: { fontSize: 16, color: colors.faint, fontWeight: "700" },
  dateConfirm: {
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
    fontSize: 13,
    color: colors.muted,
  },
});
