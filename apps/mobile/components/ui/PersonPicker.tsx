import { useEffect, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { colors } from "../../lib/theme";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useSandboxEventId } from "../event/SandboxScope";

type PersonId = string;

/** Pause after the last keystroke before the typed query is sent to the
 *  server. Short enough to feel instant in a modal the user is staring at,
 *  long enough that a typed name is one query and not one per letter. */
const SEARCH_DEBOUNCE_MS = 250;

type BaseProps = {
  visible: boolean;
  title?: string;
  /** Optional one-line context shown under the title (e.g. the Money-page
   *  item→vendor conversion prompt's cost preview) — omitted entirely when
   *  unset, so every other caller's header is unchanged. */
  subtitle?: string;
  selectedId?: PersonId | null;
  /** The picked person's id, plus the roster row itself — a caller that has to
   *  NAME the person back to the user (a confirm step: "bill Sarah $18.40?")
   *  otherwise has to re-fetch the whole roster just to turn an id into a
   *  name. Every existing caller ignores the second argument. */
  onPick: (personId: PersonId, person: { _id: string; name: string }) => void;
  onClear?: () => void;
  onClose: () => void;
  /**
   * Optional predicate to narrow the roster (e.g. exclude placeholder people
   * when replacing a placeholder volunteer).
   *
   * This is a ROSTER POLICY ("who may this caller pick at all"), not a search
   * — the search box never runs through here; it is applied server-side. A
   * predicate that tried to implement search would re-introduce exactly the
   * bug this component was fixed for (see `convex/lib/peopleSearch.ts`).
   */
  filter?: (person: any) => boolean;
  /**
   * When provided, the picker gains a "Create new person" row, so the caller
   * can either CHOOSE an existing person or CREATE one by name. It also forces
   * the search box on (a create-capable picker always needs somewhere to type
   * the new name).
   */
  onCreate?: (name: string) => void;
};

type RosterProps = BaseProps & {
  /**
   * "team" lists only team members (for owners/leads); "cardEligible" lists only
   * people with a `@publicworship.life` email (card issuance/linking); default
   * lists everyone. The picker queries this itself and hands it the search box's
   * (debounced) value, so filtering happens on the server.
   */
  source?: "all" | "team" | "cardEligible";
  people?: undefined;
  onSearchChange?: undefined;
};

type OverrideProps = BaseProps & {
  source?: undefined;
  /**
   * Pre-fetched roster, replacing this component's internal query entirely —
   * for a caller whose roster isn't "the caller's own chapter" (e.g. the
   * org-chart seat picker, keyed off the SEAT's scope via
   * `seats.assignablePeople`, not `people.list`). `undefined` means "the
   * caller's own query hasn't resolved yet" and renders as loading.
   */
  people: { _id: string; name: string }[] | undefined;
  /**
   * REQUIRED alongside `people`, and the reason that pairing is a separate
   * props variant: a caller supplying its own roster must also run its own
   * SERVER-side search, because this component will not filter the array it
   * is handed. Called with the debounced query (and `""` when the picker is
   * dismissed); feed it straight into the caller's query args.
   */
  onSearchChange: (search: string) => void;
};

type Props = RosterProps | OverrideProps;

/**
 * Centered modal popover that lists people for assigning tasks/roles/seats.
 * Rows have class-driven hover and a selected check.
 *
 * SEARCH IS SERVER-SIDE, always. The box's value is debounced and passed to
 * whichever query supplies the roster — `api.people.list` / `teamMembers` /
 * `cardEligible` here, or the caller's own query via `onSearchChange`. It is
 * never used to `.filter()` an already-fetched array.
 *
 * That is not a performance preference, it is correctness: a roster query is
 * capped, so filtering its result client-side can only ever search the part
 * of the roster the server happened to return. The org-chart seat picker read
 * a 300-per-chapter, creation-ordered slice, so searching for someone added
 * recently answered "No matches" for a person who plainly existed (reported
 * 2026-08-31). See `convex/lib/peopleSearch.ts` for the server half.
 *
 * With `onCreate`, the picker doubles as a combobox: type to search (choose),
 * or create a brand-new person from the typed name when none matches.
 */
export function PersonPicker(props: Props) {
  const {
    visible,
    title = "Assign person",
    subtitle,
    selectedId,
    onPick,
    onClear,
    onClose,
    onCreate,
    filter,
  } = props;
  // Override mode is decided by the PRESENCE of the `people` prop, not by its
  // value: a caller whose own query is still loading passes `undefined`, and
  // falling back to the internal roster query there would flash the CALLER'S
  // OWN chapter roster inside a picker scoped to somewhere else.
  const isOverride = "people" in props;
  const peopleOverride = isOverride ? props.people : undefined;
  const source = isOverride ? "all" : (props.source ?? "all");

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const searchArg = debouncedSearch.trim() || undefined;

  // Inside an Academy training sandbox, both sources collapse SERVER-SIDE to
  // the learner + placeholder people — real teammates are never offered from
  // within a drill.
  const sandboxEventId = useSandboxEventId();
  // The card-eligibility roster has no sandbox variant. Skipped entirely
  // (Convex's `"skip"` sentinel) in override mode — no point subscribing to a
  // roster the caller isn't using.
  const queried = useQuery(
    source === "cardEligible"
      ? api.people.cardEligible
      : source === "team"
        ? api.people.teamMembers
        : api.people.list,
    isOverride
      ? "skip"
      : source === "cardEligible"
        ? { search: searchArg }
        : sandboxEventId
          ? { eventId: sandboxEventId as Id<"events">, search: searchArg }
          : { search: searchArg },
  );
  const people = isOverride ? peopleOverride : queried;

  // Hand the debounced query to an override caller so IT can re-query. Held in
  // a ref so a caller passing an inline arrow doesn't re-fire this on every
  // render.
  const onSearchChangeRef = useRef(isOverride ? props.onSearchChange : undefined);
  onSearchChangeRef.current = isOverride ? props.onSearchChange : undefined;
  useEffect(() => {
    onSearchChangeRef.current?.(debouncedSearch.trim());
  }, [debouncedSearch]);

  // Reset the query each time the modal is dismissed so it opens fresh — and
  // tell an override caller to drop its own search filter too.
  useEffect(() => {
    if (!visible) {
      setSearch("");
      onSearchChangeRef.current?.("");
    }
  }, [visible]);

  // The search box appears once there is more than one person to choose from
  // (no point searching a single-name roster) — and then STAYS, because the
  // list it is filtering is now the search's own result: letting a narrow
  // result hide the box would strand the user with no way to widen it again.
  const [searchBoxShown, setSearchBoxShown] = useState(false);
  useEffect(() => {
    if (!visible) setSearchBoxShown(false);
  }, [visible]);
  useEffect(() => {
    if ((people?.length ?? 0) > 1) setSearchBoxShown(true);
  }, [people]);
  const showSearch = !!onCreate || searchBoxShown;

  const list = (people ?? []).filter((p: any) => (filter ? filter(p) : true));
  const typed = search.trim();
  const exactMatch = list.some(
    (p: any) => p.name.trim().toLowerCase() === typed.toLowerCase(),
  );
  const canCreate = !!onCreate && typed.length > 0 && !exactMatch;
  // A keystroke that hasn't reached the server yet — the rows on screen answer
  // the PREVIOUS query, so say so rather than flashing a wrong "No matches".
  const searchPending = search !== debouncedSearch;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="border-b border-border px-5 py-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-display text-lg text-ink">{title}</Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            {subtitle ? (
              <Text className="mt-1 text-sm text-muted">{subtitle}</Text>
            ) : null}
          </View>

          {showSearch ? (
            <View className="border-b border-border px-5 py-3">
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={
                  onCreate
                    ? "Search people, or type a new name…"
                    : "Search people…"
                }
                placeholderTextColor={colors.faint}
                autoFocus
                autoCapitalize="words"
                className="rounded-md border border-border bg-raised px-3 py-2.5 text-base text-ink"
              />
            </View>
          ) : null}

          <ScrollView className="max-h-96">
            {onClear ? (
              <Row label="Clear assignment" muted icon="user-x" onPress={onClear} />
            ) : null}

            {people === undefined || (searchPending && list.length === 0) ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                {typed ? "Searching…" : "Loading…"}
              </Text>
            ) : list.length === 0 && !canCreate ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                {typed ? "No matches." : "No people yet. Add some first."}
              </Text>
            ) : (
              list.map((p: any) => (
                <Row
                  key={p._id}
                  label={p.name}
                  selected={p._id === selectedId}
                  onPress={() => onPick(p._id, p)}
                />
              ))
            )}

            {canCreate ? (
              <Row
                label={`Create “${typed}”`}
                muted
                icon="user-plus"
                onPress={() => onCreate!(typed)}
              />
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  selected,
  muted,
  icon,
  onPress,
}: {
  label: string;
  selected?: boolean;
  muted?: boolean;
  icon?: "user-x" | "user-plus";
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between border-b border-border px-5 py-3 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <View className="flex-row items-center gap-3">
        {muted ? (
          <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
            <Icon name={icon ?? "user"} size={14} color={colors.muted} />
          </View>
        ) : (
          <Avatar name={label} size={28} />
        )}
        <Text
          className={`text-base ${
            muted
              ? "text-muted"
              : selected
                ? "font-semibold text-accent"
                : "text-ink"
          }`}
        >
          {label}
        </Text>
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
