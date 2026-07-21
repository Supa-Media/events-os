/**
 * MentionText — read-mode renderer for a `notes` string that may contain
 * `@mention` markup (see `@events-os/shared`'s `mentions.ts`).
 *
 * Splits the text into segments and resolves each mention against
 * already-loaded `people`/`seatHoldings` data (`resolveMentionToken`). A
 * resolved mention renders as tappable text that jumps to that person's
 * card on the People page (`/people?openId=<personId>`) — for a role
 * mention this is WHOEVER CURRENTLY HOLDS the seat, so the link stays
 * correct as the seat changes hands with no edit to the note. An
 * unresolved mention (deleted person, vacant seat) falls back to its
 * captured label as plain, non-interactive text instead of a broken link.
 */
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { splitMentionSegments } from "@events-os/shared";
import { resolveMentionToken } from "./mentionResolve.logic";
import { colors } from "../../lib/theme";

export function MentionText({
  text,
  people,
  seatHoldings,
}: {
  text: string;
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
}) {
  const router = useRouter();
  const segments = splitMentionSegments(text);

  return (
    <Text className="px-2 text-sm text-ink" numberOfLines={1}>
      {segments.map((segment, i) => {
        if (segment.kind === "text") {
          return <Text key={i}>{segment.text}</Text>;
        }
        const resolved = resolveMentionToken(segment.token, {
          people,
          seatHoldings,
        });
        if (!resolved) {
          return (
            <Text key={i} className="italic text-faint">
              {segment.token.label}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            style={{ color: colors.info }}
            onPress={() =>
              router.push(`/people?openId=${resolved.personId}` as any)
            }
          >
            {segment.token.label}
          </Text>
        );
      })}
    </Text>
  );
}
