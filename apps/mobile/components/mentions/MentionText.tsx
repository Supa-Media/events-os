/**
 * MentionText — read-mode renderer for a `notes` string that may contain
 * `@mention` markup (see `@events-os/shared`'s `mentions.ts`).
 *
 * Splits the text into segments and resolves each mention against
 * already-loaded `people`/`seatHoldings` data (`resolveMentionToken`). A
 * resolved mention renders as tappable text that opens a read-only
 * `PersonDetailModal` in place — for a role mention this is WHOEVER
 * CURRENTLY HOLDS the seat, so the modal stays correct as the seat changes
 * hands with no edit to the note. Leaving the page (to the People tab's
 * full profile) is the modal's own explicit "View full profile" button, not
 * the default outcome of a tap. An unresolved mention (deleted person,
 * vacant seat) falls back to its captured label as plain, non-interactive
 * text instead of a broken link.
 */
import { useState } from "react";
import { Text } from "react-native";
import { splitMentionSegments } from "@events-os/shared";
import { resolveMentionToken } from "./mentionResolve.logic";
import { PersonDetailModal } from "../people/PersonDetailModal";
import { colors } from "../../lib/theme";

export function MentionText({
  text,
  people,
  seatHoldings,
  numberOfLines,
}: {
  text: string;
  people: { _id: string; name: string }[];
  seatHoldings: { personId: string; seatDefId: string }[];
  /** Line clamp for the whole rendered note; omit to wrap freely (grid longtext). */
  numberOfLines?: number;
}) {
  const [openPersonId, setOpenPersonId] = useState<string | null>(null);
  const segments = splitMentionSegments(text);

  return (
    <>
      <Text className="px-2 text-sm text-ink" numberOfLines={numberOfLines}>
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
              // stopPropagation: when this renders inside a tap-to-edit cell
              // (MentionInlineText), tapping the link must open the modal,
              // not ALSO flip the cell into edit mode underneath it.
              onPress={(e) => {
                e?.stopPropagation?.();
                setOpenPersonId(resolved.personId);
              }}
            >
              {segment.token.label}
            </Text>
          );
        })}
      </Text>
      {openPersonId ? (
        <PersonDetailModal
          personId={openPersonId}
          onClose={() => setOpenPersonId(null)}
        />
      ) : null}
    </>
  );
}
