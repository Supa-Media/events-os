/**
 * Proposals inbox — a compact strip above the tree, visible only when there's
 * something to act on. `seatProposals.pendingProposals({})` already returns
 * exactly "every pending proposal the caller could decide OR that they
 * themselves proposed" (see that query's doc comment) — no scope narrowing
 * here, since the org chart itself is org-transparent.
 *
 * That query's row shape has no "is this mine to decide vs mine to cancel"
 * flag, so this component derives it CLIENT-SIDE: it also fetches
 * `myProposals({})` (every proposal, any status, the caller made) and
 * intersects the two by `proposalId` — a row present in BOTH lists is one
 * the caller proposed themselves (offer Cancel); everything else in
 * `pendingProposals` is one the caller is an eligible DECIDER for (offer
 * Approve/Decline). This is exact, not a heuristic: `pendingProposals`'s own
 * definition guarantees every row is one or the other.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Card, Icon, SectionHeader } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../event/ticketing/helpers";

type Proposal = NonNullable<ReturnType<typeof useQuery<typeof api.seatProposals.pendingProposals>>>[number];

export function ProposalsInbox() {
  const pending = useQuery(api.seatProposals.pendingProposals, {});
  const mine = useQuery(api.seatProposals.myProposals, {});

  const myPendingIds = useMemo(() => {
    return new Set((mine ?? []).filter((p) => p.status === "pending").map((p) => p.proposalId));
  }, [mine]);

  if (!pending || pending.length === 0) return null;

  return (
    <View className="mb-2">
      <SectionHeader title="Proposals" count={pending.length} />
      <View className="gap-2">
        {pending.map((p) => (
          <ProposalCard key={p.proposalId} proposal={p} isMine={myPendingIds.has(p.proposalId)} />
        ))}
      </View>
    </View>
  );
}

function ProposalCard({ proposal, isMine }: { proposal: Proposal; isMine: boolean }) {
  const approve = useMutation(api.seatProposals.approve);
  const decline = useMutation(api.seatProposals.decline);
  const cancel = useMutation(api.seatProposals.cancel);
  const [busy, setBusy] = useState<"approve" | "decline" | "cancel" | null>(null);

  async function run(id: "approve" | "decline" | "cancel", fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      // On success the row simply disappears from `pendingProposals` once
      // the mutation commits (reactive query) — nothing else to do here.
    } catch (err) {
      // Per spec: an approve/decline failure surfaces the error and LEAVES
      // the card — the proposal stays pending by design (the underlying
      // seat state may become valid again later).
      alertError(err);
    } finally {
      setBusy(null);
    }
  }

  const verb = proposal.action === "fill" ? "fill" : "vacate";

  return (
    <Card padding="md">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-sm text-ink">
            <Text className="font-semibold">{proposal.proposedByName}</Text> proposes to{" "}
            <Text className="font-semibold">{verb}</Text>{" "}
            <Text className="font-semibold">{proposal.seatTitle}</Text>
            {proposal.action === "fill" ? " with " : " for "}
            <Text className="font-semibold">{proposal.subjectName}</Text>
          </Text>
          <Text className="text-xs text-muted">{proposal.scopeName}</Text>
          {proposal.note ? (
            <Text className="mt-1 text-xs italic text-muted">&ldquo;{proposal.note}&rdquo;</Text>
          ) : null}
        </View>
        <Icon name="git-pull-request" size={16} color={colors.faint} />
      </View>

      <View className="mt-3 flex-row justify-end gap-2">
        {isMine ? (
          <Button
            title="Cancel"
            variant="ghost"
            size="sm"
            loading={busy === "cancel"}
            onPress={() =>
              confirmAction({
                title: "Cancel this proposal?",
                message: `Withdraw the proposal to ${verb} ${proposal.seatTitle}.`,
                confirmLabel: "Cancel proposal",
                destructive: true,
                onConfirm: () =>
                  void run("cancel", () => cancel({ proposalId: proposal.proposalId })),
              })
            }
          />
        ) : (
          <>
            <Button
              title="Decline"
              variant="secondary"
              size="sm"
              loading={busy === "decline"}
              onPress={() =>
                void run("decline", () => decline({ proposalId: proposal.proposalId }))
              }
            />
            <Button
              title="Approve"
              variant="primary"
              size="sm"
              loading={busy === "approve"}
              onPress={() =>
                void run("approve", () => approve({ proposalId: proposal.proposalId }))
              }
            />
          </>
        )}
      </View>
    </Card>
  );
}
