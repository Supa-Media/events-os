/**
 * The self-serve "Create my card" block (`api.cards.createMyCard`): one tap
 * and the member has their own Increase card — no request, no approval
 * (founder call, 2026-10-02). The Academy-prerequisite warning shows, and the
 * button is disabled, while a required course is unfinished; the server
 * enforces the same gate (and the `@publicworship.life` email rule) either way.
 *
 * Two callers in `MemberCardsView`: the member with no card at all, and the
 * member whose only card is a legacy Relay card — the Relay cards were frozen,
 * and this is how a Relay holder moves to Increase. `emptyTitle`/`emptyMessage`
 * are the only difference between the two. Once the card exists, `myCard`
 * returns it and `MyCardSection` takes over; nothing else to update here.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, EmptyState, Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

export function CreateCardPanel({
  emptyTitle,
  emptyMessage,
}: {
  emptyTitle: string;
  emptyMessage: string;
}) {
  // The org-wide card-prerequisite course + whether the caller has finished it
  // (null when there's no gate).
  const prerequisite = useQuery(api.cards.cardPrerequisiteStatus, {});
  const createMyCard = useAction(api.cards.createMyCard);
  const { run, toast, dismiss } = useActionRunner();
  const [creating, setCreating] = useState(false);

  const blocked = prerequisite != null && !prerequisite.met;

  async function handleCreate() {
    setCreating(true);
    await run(() => createMyCard({}), { errorTitle: "Couldn't create your card" });
    setCreating(false);
  }

  return (
    <View className="gap-3">
      {blocked ? (
        <View className="flex-row items-center gap-2 rounded-md border border-warn bg-warn-bg px-3 py-2">
          <Icon name="book-open" size={14} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            Complete{" "}
            <Text className="font-semibold">{prerequisite?.title}</Text> in the
            Academy to get a card.
          </Text>
        </View>
      ) : null}
      <EmptyState icon="credit-card" title={emptyTitle} message={emptyMessage} />
      <Button
        title="Create my card"
        icon="plus"
        onPress={handleCreate}
        loading={creating}
        disabled={blocked}
      />
      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}
