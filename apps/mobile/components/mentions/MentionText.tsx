/**
 * MentionText — read-mode renderer for a `notes` string that may contain
 * `@mention` markup (see `@events-os/shared`'s `mentions.ts`).
 *
 * Splits the text into segments and resolves each mention against
 * already-loaded `people`/`seatHoldings` data (`resolveMentionToken`). A
 * resolved mention renders as tappable text that opens a `PersonPreviewModal`
 * IN PLACE — for a role mention this shows WHOEVER CURRENTLY HOLDS the seat,
 * so the note keeps pointing at whoever holds the seat as it changes hands,
 * with no edit to the note required. The modal has its own "View full
 * profile" button for anyone who wants to jump to that person's full record
 * on the People tab. An unresolved mention (deleted person, vacant seat)
 * falls back to its captured label as plain, non-interactive text instead of
 * a broken link.
 */
import { useState } from "react";
import { Text } from "react-native";
import { splitMentionSegments } from "@events-os/shared";
import { resolveMentionToken } from "./mentionResolve.logic";
import { PersonPreviewModal } from "../people/PersonPreviewModal";
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
  const segments = splitMentionSegments(text);
  const [openPerson, setOpenPerson] = useState<{
    id: string;
    name: string;
  } | null>(null);

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
              // (MentionInlineText), tapping the link must open the preview
              // modal, not ALSO flip the cell into edit mode underneath it.
              onPress={(e) => {
                e?.stopPropagation?.();
                setOpenPerson({ id: resolved.personId, name: resolved.displayName });
              }}
            >
              {segment.token.label}
            </Text>
          );
        })}
      </Text>
      <PersonPreviewModal
        personId={openPerson?.id ?? null}
        name={openPerson?.name ?? ""}
        onClose={() => setOpenPerson(null)}
      />
    </>
  );
}
