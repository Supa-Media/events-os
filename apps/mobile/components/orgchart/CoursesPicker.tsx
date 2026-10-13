/**
 * The ONE place a seat's Academy courses are chosen — opened from a seat's
 * Overview tab ("Training") and from Add seat. The chosen list, in order, is
 * the seat's role path: what Academy shows the people in that seat under
 * "Your path".
 *
 * Top: the seat's courses in path order, each with move up/down and remove.
 * Below: every course in the catalog, grouped by stream and searchable; a tap
 * adds it to the end of the path (or takes it off). Changes collect in a
 * draft and save together, same as `PowersPicker`.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ACADEMY_COURSES, ACADEMY_THEMES, getAcademyCourse } from "@events-os/shared";
import { Button, Icon, type IconName } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { OrgModal, SearchBox } from "./OrgModal";

/** Move one entry of `list` by `delta` places, clamped. Exported for tests. */
export function moveCourse(list: readonly string[], slug: string, delta: -1 | 1): string[] {
  const i = list.indexOf(slug);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function CoursesPicker({
  visible,
  seatTitle,
  initial,
  onSave,
  onClose,
}: {
  visible: boolean;
  seatTitle: string;
  /** The seat's current courses, in path order, when the picker opens. */
  initial: readonly string[];
  onSave: (next: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string[]>(() => [...initial]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setDraft([...initial]);
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = ACADEMY_COURSES.filter(
      (c) => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
    return ACADEMY_THEMES.map((t) => ({
      theme: t,
      courses: shown.filter((c) => c.themeKey === t.key),
    })).filter((g) => g.courses.length > 0);
  }, [query]);

  const dirty = draft.length !== initial.length || draft.some((c, i) => c !== initial[i]);
  const chosen = new Set(draft);

  function toggle(slug: string) {
    setDraft((prev) => (prev.includes(slug) ? prev.filter((c) => c !== slug) : [...prev, slug]));
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <OrgModal
      visible={visible}
      wide
      title={`Courses for ${seatTitle}`}
      subtitle={`${draft.length} ${draft.length === 1 ? "course" : "courses"} · taken in this order`}
      onClose={onClose}
      header={<SearchBox value={query} onChangeText={setQuery} placeholder="Search courses" />}
      footer={
        <>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Save courses" onPress={() => void save()} disabled={!dirty} loading={saving} />
        </>
      }
    >
      <Text className="bg-sunken px-5 py-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
        This seat&rsquo;s path
      </Text>
      {draft.length === 0 ? (
        <Text className="border-t border-border px-5 py-3 text-sm text-muted">
          No courses yet. Add some from the list below.
        </Text>
      ) : (
        draft.map((slug, i) => {
          const course = getAcademyCourse(slug);
          return (
            <View key={slug} className="flex-row items-center gap-2 border-t border-border px-5 py-2">
              <Text className="w-5 text-xs text-faint">{i + 1}</Text>
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {course?.title ?? slug}
              </Text>
              <IconButton icon="arrow-up" label="Move up" disabled={i === 0} onPress={() => setDraft((d) => moveCourse(d, slug, -1))} />
              <IconButton
                icon="arrow-down"
                label="Move down"
                disabled={i === draft.length - 1}
                onPress={() => setDraft((d) => moveCourse(d, slug, 1))}
              />
              <IconButton icon="x" label="Remove" onPress={() => toggle(slug)} />
            </View>
          );
        })
      )}

      {groups.length === 0 ? (
        <Text className="px-5 py-8 text-sm text-muted">No course matches &ldquo;{query}&rdquo;.</Text>
      ) : (
        groups.map(({ theme, courses }) => (
          <View key={theme.key}>
            <Text className="bg-sunken px-5 py-1.5 text-2xs font-bold uppercase tracking-wider text-muted">
              {theme.title}
            </Text>
            {courses.map((c) => {
              const on = chosen.has(c.slug);
              return (
                <Pressable
                  key={c.slug}
                  onPress={() => toggle(c.slug)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  aria-checked={on}
                  accessibilityLabel={c.title}
                  className="flex-row items-center gap-3 border-t border-border px-5 py-2.5 active:bg-sunken web:hover:bg-sunken"
                >
                  <Icon name={c.icon as IconName} size={16} color={on ? colors.accent : colors.muted} />
                  <View className="flex-1">
                    <Text className={`text-sm ${on ? "font-semibold text-ink" : "text-ink"}`}>{c.title}</Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {c.description}
                    </Text>
                  </View>
                  <Icon name={on ? "check-circle" : "plus-circle"} size={18} color={on ? colors.accent : colors.faint} />
                </Pressable>
              );
            })}
          </View>
        ))
      )}
    </OrgModal>
  );
}

function IconButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`rounded-md p-1 ${disabled ? "opacity-30" : "web:hover:bg-sunken"}`}
    >
      <Icon name={icon} size={16} color={colors.muted} />
    </Pressable>
  );
}
