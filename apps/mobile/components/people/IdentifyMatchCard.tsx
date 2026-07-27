/**
 * People → Identify — the "same/different" card for buckets 2 (name
 * matches) and 3 (duplicate people). Two columns compare the guest/subject
 * side against the candidate side; the `⚠` evidence line states WHY they
 * look alike (a human deciding needs the evidence, not just the names — see
 * `lib/identifyQueue.ts#evidenceLine`).
 *
 * A `name_match` row's left side is a bare name-only RSVP guest (no
 * email/phone exists to show); a `duplicate` row's left side is a full
 * `people` record, same shape as the right. `pickMergeDirection` (screen
 * owns calling it, not this component) decides which of subject/candidate
 * survives a merge.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, Icon } from "../ui";
import { colors } from "../../lib/theme";
import {
  candidateTagLine,
  evidenceLine,
  type HighConfidenceCard,
  type PersonCandidate,
} from "../../lib/identifyQueue";

export function IdentifyMatchCard({
  card,
  position,
  total,
  busy,
  onSame,
  onDifferent,
  onNotSure,
}: {
  card: HighConfidenceCard;
  position: number;
  total: number;
  busy: boolean;
  onSame: () => void;
  onDifferent: () => void;
  onNotSure: () => void;
}) {
  const [pending, setPending] = useState<"same" | "different" | null>(null);

  function press(which: "same" | "different", fn: () => void) {
    setPending(which);
    fn();
  }

  return (
    <Card padding="md">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="font-display text-lg text-ink">Same person?</Text>
        <Text className="text-xs font-semibold text-faint">
          {position} of {total}
        </Text>
      </View>

      <View className="flex-row gap-3">
        <ComparisonColumn card={card} side="left" />
        <View className="w-px bg-border" />
        <ComparisonColumn card={card} side="right" />
      </View>

      <View className="mt-3 flex-row items-center gap-1.5">
        <Icon name="alert-triangle" size={13} color={colors.warn} />
        <Text className="text-xs text-warn">{evidenceLine(card)}</Text>
      </View>

      <View className="mt-4 flex-row flex-wrap justify-end gap-2">
        <Button
          title="Not sure"
          variant="ghost"
          size="sm"
          icon="arrow-right"
          disabled={busy}
          onPress={onNotSure}
        />
        <Button
          title="Different"
          variant="secondary"
          size="sm"
          loading={busy && pending === "different"}
          disabled={busy}
          onPress={() => press("different", onDifferent)}
        />
        <Button
          title={card.kind === "duplicate" ? "Same — merge" : "Same"}
          variant="primary"
          size="sm"
          loading={busy && pending === "same"}
          disabled={busy}
          onPress={() => press("same", onSame)}
        />
      </View>
    </Card>
  );
}

function ComparisonColumn({
  card,
  side,
}: {
  card: HighConfidenceCard;
  side: "left" | "right";
}) {
  if (card.kind === "name_match") {
    if (side === "left") {
      // The guest side is a bare name-only RSVP — no email/phone exists to
      // show, only what the RSVPs themselves carry.
      return (
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {card.row.displayName}
          </Text>
          <Text className="text-xs text-muted">
            {card.row.eventCount} event{card.row.eventCount === 1 ? "" : "s"}
          </Text>
        </View>
      );
    }
    return <PersonColumn person={card.row.candidate} />;
  }
  return <PersonColumn person={side === "left" ? card.row.subject : card.row.candidate} />;
}

function PersonColumn({ person }: { person: PersonCandidate }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
        {person.name}
      </Text>
      {person.email ? (
        <Text className="text-xs text-muted" numberOfLines={1}>
          {person.email}
        </Text>
      ) : null}
      {person.phone ? (
        <Text className="text-xs text-muted" numberOfLines={1}>
          {person.phone}
        </Text>
      ) : null}
      <Text className="text-xs text-faint">{candidateTagLine(person)}</Text>
    </View>
  );
}
