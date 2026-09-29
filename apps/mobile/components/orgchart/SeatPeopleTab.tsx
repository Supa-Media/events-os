/**
 * A seat's People tab: who holds it, the open spots, and the proposals about
 * it that are waiting on the viewer.
 *
 * Someone with the Fill seats power (`seatDetail.canFillSeats`: superuser or
 * `org.seats.edit`, which the ED holds through `org.chart.edit`) changes
 * holders right on the rows — Add, Replace, Remove — through
 * `seats.assignSeat` / `unassignSeat`. Everyone else gets the same list with
 * "Propose a change", the two-party flow in `SeatActions.tsx`. Before this,
 * direct assignment sat behind a separate superuser-only modal, so the ED
 * could only staff the chart by being a superuser.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar, Button, Icon, PersonPicker } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";
import { ProposalCard } from "./ProposalsInbox";
import { ProposeChangeModal, type HolderLite } from "./SeatActions";
import { avatarNameFor, type NodeScope } from "./treeUtils";

export function SeatPeopleTab({
  seatDefId,
  scope,
  seatTitle,
  maxHolders,
  holders,
  derived,
  canFill,
}: {
  seatDefId: Id<"seatDefs">;
  scope: NodeScope;
  seatTitle: string;
  maxHolders: number;
  holders: HolderLite[];
  derived: boolean;
  canFill: boolean;
}) {
  const assignSeat = useMutation(api.seats.assignSeat);
  const unassignSeat = useMutation(api.seats.unassignSeat);
  const [personSearch, setPersonSearch] = useState("");
  const [picker, setPicker] = useState<null | { replacing: HolderLite | null }>(null);
  const [proposeOpen, setProposeOpen] = useState(false);

  const people = useQuery(
    api.seats.assignablePeople,
    picker ? { scope, ...(personSearch ? { search: personSearch } : {}) } : "skip",
  );
  const pickerPeople = useMemo(
    () => people?.map((p) => ({ _id: p.personId, name: p.name })),
    [people],
  );

  // Proposals about THIS seat at THIS scope that the viewer can decide or
  // withdraw — the same rows the toolbar inbox shows, narrowed.
  const pending = useQuery(api.seatProposals.pendingProposals, derived ? "skip" : { scope });
  const mine = useQuery(api.seatProposals.myProposals, derived ? "skip" : {});
  const seatPending = (pending ?? []).filter((p) => p.seatDefId === seatDefId);
  const myPendingIds = new Set(
    (mine ?? []).filter((p) => p.status === "pending").map((p) => p.proposalId),
  );

  const single = maxHolders === 1;
  const openSpots = single ? (holders.length === 0 ? 1 : 0) : Math.max(0, maxHolders - holders.length);

  function pick(personId: string, name: string) {
    const replacing = picker?.replacing ?? null;
    setPicker(null);
    const commit = async () => {
      try {
        if (replacing?.assignmentId && !single) {
          await unassignSeat({ assignmentId: replacing.assignmentId });
        }
        // A single-holder seat replaces its incumbent inside `assignSeat`.
        await assignSeat({ seatDefId, scope, personId: personId as Id<"people"> });
      } catch (err) {
        alertError(err);
      }
    };
    confirmAction({
      title: replacing ? `Replace ${replacing.name}?` : `Add ${name}?`,
      message: replacing
        ? `${name} takes ${replacing.name}'s place in ${seatTitle} right away.`
        : `${name} joins ${seatTitle} right away.`,
      confirmLabel: replacing ? "Replace" : "Add",
      destructive: !!replacing,
      onConfirm: () => void commit(),
    });
  }

  function remove(h: HolderLite) {
    if (!h.assignmentId) return;
    const assignmentId = h.assignmentId;
    confirmAction({
      title: `Remove ${h.name}?`,
      message: `${h.name} leaves ${seatTitle} right away, and loses the powers that came with it.`,
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => void unassignSeat({ assignmentId }).catch(alertError),
    });
  }

  if (derived) {
    return (
      <View className="gap-3">
        <Text className="text-sm text-muted">
          Holders here are filled in automatically from each chapter&apos;s own seat. Change them
          on that chapter&apos;s chart.
        </Text>
        <HolderList holders={holders} />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <Text className="text-xs text-muted">
        {single
          ? "One person holds this seat."
          : `${holders.length} of up to ${maxHolders} people hold this seat.`}
      </Text>

      <View>
        {holders.map((h, i) => (
          <View
            key={h.personId}
            className={`flex-row items-center gap-2.5 py-2 ${i > 0 ? "border-t border-border" : ""}`}
          >
            <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={30} />
            <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
              {h.name}
            </Text>
            {canFill ? (
              <>
                <Button title="Replace" variant="secondary" size="sm" onPress={() => setPicker({ replacing: h })} />
                {h.assignmentId ? (
                  <Pressable
                    onPress={() => remove(h)}
                    hitSlop={8}
                    className="rounded-md p-1"
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${h.name}`}
                  >
                    <Icon name="x" size={16} color={colors.faint} />
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>
        ))}
        {openSpots > 0 ? (
          <View
            className={`flex-row items-center gap-2.5 py-2 ${holders.length ? "border-t border-border" : ""}`}
          >
            <View className="h-[30px] w-[30px] items-center justify-center rounded-full border border-dashed border-border-strong">
              <Icon name="plus" size={14} color={colors.faint} />
            </View>
            <Text className="flex-1 text-sm text-muted">
              {holders.length === 0 ? "Vacant" : "Open spot"}
            </Text>
          </View>
        ) : null}
      </View>

      {canFill ? (
        openSpots > 0 ? (
          <Button
            title="Add a person"
            icon="user-plus"
            size="sm"
            onPress={() => setPicker({ replacing: null })}
            className="self-start"
          />
        ) : null
      ) : (
        <View className="gap-2">
          <Button
            title="Propose a change"
            variant="secondary"
            icon="git-pull-request"
            size="sm"
            onPress={() => setProposeOpen(true)}
            className="self-start"
          />
          <Text className="text-xs text-faint">
            Someone above this seat approves it before it takes effect.
          </Text>
        </View>
      )}

      {seatPending.length > 0 ? (
        <View className="gap-2">
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            Waiting on a decision
          </Text>
          {seatPending.map((p) => (
            <ProposalCard key={p.proposalId} proposal={p} isMine={myPendingIds.has(p.proposalId)} />
          ))}
        </View>
      ) : null}

      <PersonPicker
        visible={!!picker}
        title={picker?.replacing ? `Replace ${picker.replacing.name} with…` : `Add to ${seatTitle}`}
        people={pickerPeople}
        onSearchChange={setPersonSearch}
        onPick={(personId, person) => pick(personId, person.name)}
        onClose={() => setPicker(null)}
      />
      <ProposeChangeModal
        visible={proposeOpen}
        seatDefId={seatDefId}
        scope={scope}
        seatTitle={seatTitle}
        holders={holders}
        onClose={() => setProposeOpen(false)}
      />
    </View>
  );
}

function HolderList({ holders }: { holders: HolderLite[] }) {
  if (holders.length === 0) return <Text className="text-sm italic text-faint">Vacant</Text>;
  return (
    <View className="gap-2.5">
      {holders.map((h) => (
        <View key={h.personId} className="flex-row items-center gap-2.5">
          <Avatar name={avatarNameFor(h.name)} uri={h.imageUrl} size={28} />
          <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
            {h.name}
          </Text>
        </View>
      ))}
    </View>
  );
}
