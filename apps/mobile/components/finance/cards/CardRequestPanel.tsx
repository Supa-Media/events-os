/**
 * The self-serve "request a card" block: the Academy-prerequisite warning, the
 * pending / denied state of the caller's latest request, and the note field +
 * "Request a card" button (`api.cards.requestCard`). A finance manager then
 * approves it from the Cards tab's pending-requests list, which issues the
 * Increase card.
 *
 * Two callers in `MemberCardsView`: the member with no card at all, and the
 * member whose only card is a legacy Relay card. The second used to get a
 * dead end ("ask a finance manager") even though `requestCard` deliberately
 * ignores Relay cards so a mid-migration holder CAN request a real one — so
 * when the Relay cards were frozen, nobody holding one could ask for a
 * replacement from the app. `emptyTitle`/`emptyMessage` are the only
 * difference between the two.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, EmptyState, Icon, TextField, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

export function CardRequestPanel({
  emptyTitle,
  emptyMessage,
}: {
  emptyTitle: string;
  emptyMessage: string;
}) {
  const myRequest = useQuery(api.cards.myCardRequest, {});
  // The org-wide card-prerequisite course + whether the caller has finished it
  // (null when there's no gate). When a prerequisite is set and unmet, tell the
  // member exactly what to complete to get a card.
  const prerequisite = useQuery(api.cards.cardPrerequisiteStatus, {});
  const requestCard = useMutation(api.cards.requestCard);
  const { run, toast, dismiss } = useActionRunner();

  const [requestNote, setRequestNote] = useState("");
  const [requesting, setRequesting] = useState(false);

  async function handleRequestCard() {
    setRequesting(true);
    await run(
      () => requestCard({ note: requestNote.trim() || undefined }),
      { errorTitle: "Couldn't submit request" },
    );
    setRequesting(false);
    setRequestNote("");
  }

  return (
    <View>
      {prerequisite && !prerequisite.met ? (
        <View className="mb-3 flex-row items-center gap-2 rounded-md border border-warn bg-warn-bg px-3 py-2">
          <Icon name="book-open" size={14} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            Complete{" "}
            <Text className="font-semibold">{prerequisite.title}</Text> in the
            Academy to get a card.
          </Text>
        </View>
      ) : null}
      {myRequest?.status === "requested" ? (
        <EmptyState
          icon="clock"
          title="Request pending"
          message="Your card request is waiting on a finance manager to approve it."
        />
      ) : (
        <View className="gap-3">
          <EmptyState icon="credit-card" title={emptyTitle} message={emptyMessage} />
          {myRequest?.status === "denied" ? (
            <View className="rounded-md border border-warn bg-warn-bg px-3 py-2">
              <Text className="text-xs text-warn">
                Your last request was denied. You can request again below.
              </Text>
            </View>
          ) : null}
          <TextField
            label="Note (optional)"
            hint="Why you need a card — helps the finance manager decide."
            value={requestNote}
            onChangeText={setRequestNote}
            placeholder="e.g. New hire, needs supplies budget"
          />
          <Button
            title="Request a card"
            icon="send"
            onPress={handleRequestCard}
            loading={requesting}
          />
        </View>
      )}
      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}
