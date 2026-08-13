/**
 * "YOU ASKED FOR A BOOK I CAN'T OPEN — HERE'S THE ONE YOU'RE LOOKING AT."
 *
 * The visible half of `bookScope.ts`. `resolveBookScope` keeps an unusable
 * `?scope=` (the grid's `"all"`, a stale id, a hand-edited URL) from reaching
 * a single-book query; this says so, because the fix for a crash must not be
 * a screen that shows a different book than its address names. Finance's
 * standing rule is that scope is UNMISTAKABLE — a silent substitution here
 * would trade a loud bug for a quiet one, and a quiet one on the surface
 * where months get published is the worse trade.
 *
 * It also carries the way OUT: the books the caller can actually name, one
 * tap each, so the sentence is a fork in the road rather than an apology.
 * `useBookPicks` derives those from the SAME `ChapterContext` the shell's
 * context pill is built from, so this can never offer a book the shell won't.
 */
import { Text, View } from "react-native";
import { useMemo } from "react";
import { Button, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { useChapterContext } from "../../lib/ChapterContext";
import { bookScopeNotice, type ResolvedBookScope, type SingleBookScope } from "./bookScope";

/** One book a caller may switch to, named the way the shell names it. */
export type BookPick = { scope: SingleBookScope; label: string };

/**
 * The books this caller can name: their real desks (central, each chapter
 * seat) plus whichever chapter they are currently peeking into. Deliberately
 * NOT every peekable chapter — a central holder can peek into the whole org,
 * and fifty buttons under a one-line notice is not a picker. The shell's
 * context pill remains the full switcher; this is the short list.
 */
export function useBookPicks(): BookPick[] {
  const { seats, context } = useChapterContext();
  return useMemo(() => {
    const picks: BookPick[] = [];
    const seen = new Set<string>();
    const add = (scope: SingleBookScope, label: string) => {
      if (seen.has(scope)) return;
      seen.add(scope);
      picks.push({ scope, label });
    };
    for (const seat of seats) {
      if (seat.scope === "central") add("central", "Central");
      else add(seat.chapterId, seat.chapterName);
    }
    if (context?.kind === "peek") add(context.chapterId, context.chapterName);
    return picks;
  }, [seats, context]);
}

export function BookScopeNotice({
  resolved,
  showingName,
  onPick,
}: {
  resolved: ResolvedBookScope;
  /** The book actually on screen — the SERVER's `scopeName`, never a
   *  client-side guess, so the sentence can't be wrong about what's shown. */
  showingName: string;
  onPick: (scope: SingleBookScope) => void;
}) {
  const picks = useBookPicks();
  // Nothing was refused → nothing to explain. The overwhelmingly common case,
  // and it costs the screen nothing.
  if (!resolved.refused) return null;

  const others = picks.filter((p) => p.scope !== resolved.scope);

  return (
    <View className="mb-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
      <View className="flex-row items-start gap-3">
        <Icon name="alert-triangle" size={16} color={colors.warn} />
        <Text className="flex-1 text-sm text-ink">
          {bookScopeNotice(resolved.refused, showingName)}
          {resolved.refused.reason === "multi_book"
            ? " This screen works one book at a time."
            : ""}
        </Text>
      </View>
      {others.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-2">
          {others.map((p) => (
            <Button
              key={p.scope}
              variant="secondary"
              size="sm"
              title={`Switch to ${p.label}`}
              onPress={() => onPick(p.scope)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default BookScopeNotice;
