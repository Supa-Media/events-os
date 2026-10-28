/**
 * DUTY DETAIL PANEL — everything about one duty, opened from a row of the
 * Duties list. It replaced the old eight-column grid's wide row (2026-10-28):
 * the list shows what you scan (title, cadence, seats, reach, how-to) and this
 * panel holds what you edit (seats, people, how-to doc, description, notes).
 *
 * Same write paths and guards as the grid row it replaced: a FOREIGN duty
 * (authored by another chapter, see `DutiesGrid`'s file doc) renders
 * read-only, matching the server's `requireOwned` gate 1:1; seat changes go
 * through `guardedSeatChange`.
 */
import { View, Text, Pressable } from "react-native";
import type { ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  RESPONSIBILITY_CADENCES,
  RESPONSIBILITY_CADENCE_LABELS,
  type ResponsibilityCadence,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Icon,
  InlineText,
  OptionTag,
  SelectCell,
  type SelectOption,
} from "../ui";
import { HowToDocCell, type HowToDocSummary } from "../team/HowToDocCell";
import { MentionText } from "../mentions/MentionText";
import { MentionInlineText } from "../mentions/MentionInlineText";
import { SeatsCell, guardedSeatChange } from "./DutySeatPicker";
import { colors, spacing } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

export type Responsibility = Doc<"responsibilities"> & {
  howToDoc: HowToDocSummary | null;
  /** Non-null = this row was authored by ANOTHER chapter (an org-wide
   *  seat-mapped duty) — the authoring chapter's name. Null = the caller's
   *  OWN chapter authored it. See `responsibilities.list`'s doc comment. */
  authoredByChapterName: string | null;
};

const CADENCE_OPTIONS: SelectOption<ResponsibilityCadence>[] =
  RESPONSIBILITY_CADENCES.map((c) => ({
    value: c,
    label: RESPONSIBILITY_CADENCE_LABELS[c],
    color: c === "ad_hoc" ? "gray" : "teal",
  }));

export function DutyDetailPanel({
  row,
  holders,
  vacantSeatTitles,
  nameById,
  seatById,
  roleHolders,
  onOpenPersonPicker,
  onOpenSeatPicker,
  onClose,
  people,
  seatHoldings,
  seatOptions,
}: {
  row: Responsibility;
  /** How many people this duty reaches today. */
  holders: number;
  /** Mapped seats nobody holds right now. */
  vacantSeatTitles: string[];
  nameById: Map<Id<"people">, string>;
  seatById: Map<Id<"seatDefs">, { title: string; chart: "central" | "chapter" }>;
  roleHolders: Map<string, number>;
  onOpenPersonPicker: () => void;
  onOpenSeatPicker: () => void;
  onClose: () => void;
  /** The Notes field's `@mention` picker + resolver reuse these. */
  people: { _id: Id<"people">; name: string }[];
  seatHoldings: { personId: Id<"people">; seatDefId: Id<"seatDefs"> }[];
  seatOptions: { seatDefId: Id<"seatDefs">; title: string }[];
}) {
  const updateMutation = useMutation(api.responsibilities.update);
  const removeMutation = useMutation(api.responsibilities.remove);
  const removeAssignee = useMutation(api.responsibilities.removeAssignee);
  const removeSeatMutation = useMutation(api.responsibilities.removeSeat);
  const id = row._id;
  const isForeign = row.authoredByChapterName !== null;
  const seatIds = (row.assigneeSeatIds as Id<"seatDefs">[] | undefined) ?? [];

  const update = (
    args: Omit<Parameters<typeof updateMutation>[0], "responsibilityId">,
  ) => {
    void updateMutation({ responsibilityId: id, ...args }).catch(alertError);
  };

  return (
    <View style={{ gap: spacing.lg }}>
      <View className="flex-row items-start gap-2">
        <View className="flex-1" style={{ gap: spacing.xs }}>
          {isForeign ? (
            <>
              <Text className="font-display text-xl text-ink">
                {row.title || "Duty"}
              </Text>
              <Badge
                label={`Defined by ${row.authoredByChapterName}`}
                tone="neutral"
                icon="lock"
              />
            </>
          ) : (
            <View className="rounded-md border border-border">
              <InlineText
                value={row.title}
                placeholder="Duty"
                weight="medium"
                onCommit={(t) => {
                  if (t.trim()) update({ title: t.trim() });
                }}
              />
            </View>
          )}
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityLabel="Close details"
          className="rounded-md border border-border p-2 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name="x" size={16} color={colors.ink} />
        </Pressable>
      </View>

      <View className="flex-row" style={{ gap: spacing.sm }}>
        <Stat label="Cadence">
          {isForeign ? (
            <Text className="text-base font-semibold text-ink">
              {RESPONSIBILITY_CADENCE_LABELS[row.cadence]}
            </Text>
          ) : (
            <View className="-mx-2">
              <SelectCell
                value={row.cadence}
                options={CADENCE_OPTIONS}
                onChange={(cadence) => update({ cadence })}
              />
            </View>
          )}
        </Stat>
        <Stat label="People doing it">
          <Text
            className={`text-base font-semibold ${holders > 0 ? "text-ink" : "text-accent"}`}
          >
            {holders}
          </Text>
        </Stat>
      </View>

      <Section label="Seats">
        <View className="rounded-md border border-border">
          <SeatsCell
            seatIds={seatIds}
            legacyRoles={row.assigneeRoles ?? []}
            seatById={seatById}
            roleHolders={roleHolders}
            readOnly={isForeign}
            onOpenPicker={onOpenSeatPicker}
            onRemoveSeat={(seatDefId) =>
              guardedSeatChange({
                isAdding: false,
                currentSeatCount: seatIds.length,
                legacyRoles: row.assigneeRoles ?? [],
                commit: () => {
                  void removeSeatMutation({
                    responsibilityId: id,
                    seatDefId,
                  }).catch(alertError);
                },
              })
            }
          />
        </View>
        {vacantSeatTitles.length > 0 ? (
          <Text className="text-sm text-accent">
            {vacantSeatTitles.join(", ")}{" "}
            {vacantSeatTitles.length === 1 ? "is" : "are"} vacant. Nobody
            picks this duty up through{" "}
            {vacantSeatTitles.length === 1 ? "that seat" : "those seats"} until
            it's filled.
          </Text>
        ) : null}
      </Section>

      <Section label="People assigned directly">
        <View className="flex-row flex-wrap items-center gap-1 rounded-md border border-border px-2 py-1.5">
          {(row.assigneePersonIds ?? []).map((pid) =>
            isForeign ? (
              <OptionTag key={pid} label={nameById.get(pid) ?? "?"} />
            ) : (
              <OptionTag
                key={pid}
                label={nameById.get(pid) ?? "?"}
                onRemove={() =>
                  void removeAssignee({
                    responsibilityId: id,
                    personId: pid,
                  }).catch(alertError)
                }
              />
            ),
          )}
          {(row.assigneePersonIds ?? []).length === 0 ? (
            <Text className="text-sm text-muted">Nobody</Text>
          ) : null}
          {isForeign ? null : (
            <Pressable
              onPress={onOpenPersonPicker}
              hitSlop={6}
              accessibilityLabel="Assign a person"
              className="rounded p-0.5 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="plus" size={13} color={colors.muted} />
            </Pressable>
          )}
        </View>
      </Section>

      <Section label="How-to">
        <View className="rounded-md border border-border">
          <HowToDocCell
            doc={row.howToDoc}
            editable={!isForeign}
            onSetDoc={(docId) =>
              update(docId ? { howToDocId: docId } : { howToDocId: null })
            }
          />
        </View>
        {row.howToDoc ? null : (
          <Text className="text-sm text-muted">
            Nobody has written down how this is done yet. A how-to means a
            handoff doesn't need a meeting.
          </Text>
        )}
      </Section>

      <Section label="Description">
        <View className="rounded-md border border-border">
          {isForeign ? (
            <Text className="px-2 py-1.5 text-sm text-ink">
              {row.description || "—"}
            </Text>
          ) : (
            <InlineText
              value={row.description ?? ""}
              placeholder="What does done look like?"
              onCommit={(t) => update({ description: t.trim() || null })}
            />
          )}
        </View>
      </Section>

      <Section label="Notes">
        <View className="rounded-md border border-border">
          {isForeign ? (
            row.notes ? (
              <MentionText
                text={row.notes}
                people={people}
                seatHoldings={seatHoldings}
              />
            ) : (
              <Text className="px-2 py-1.5 text-sm text-ink">—</Text>
            )
          ) : (
            <MentionInlineText
              value={row.notes ?? ""}
              placeholder="Add a note, @mention someone"
              people={people}
              seatHoldings={seatHoldings}
              seatOptions={seatOptions}
              onCommit={(t) => update({ notes: String(t).trim() || null })}
            />
          )}
        </View>
      </Section>

      {isForeign ? (
        <Text className="text-sm text-muted">
          Only {row.authoredByChapterName}'s managers can change this duty.
        </Text>
      ) : (
        <View className="flex-row border-t border-border pt-3">
          <Button
            title="Delete duty"
            icon="trash-2"
            size="sm"
            variant="ghost"
            onPress={() =>
              confirmAction({
                title: "Delete duty?",
                message: `"${row.title || "This duty"}" will be removed for everyone holding it.`,
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: () => {
                  onClose();
                  void removeMutation({ responsibilityId: id }).catch(alertError);
                },
              })
            }
          />
        </View>
      )}
    </View>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      {children}
    </View>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-1 rounded-md bg-sunken px-3 py-2" style={{ gap: 2 }}>
      <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
        {label}
      </Text>
      {children}
    </View>
  );
}
