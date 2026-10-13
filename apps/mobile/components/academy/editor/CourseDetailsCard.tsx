import { Text, View } from "react-native";
import type { AcademyLevel, AcademyThemeKey, CourseEdit, Theme } from "@events-os/shared";
import { Card, Icon, Pill, Radio, RadioGroup, Select, TextField, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import { EditorLabel } from "./EditorBits";

const LEVELS: { value: AcademyLevel; label: string }[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
  { value: "leader", label: "Leader" },
];

/** Glyphs a course can wear — the ones the built-in courses already use,
 *  plus a few general ones. */
const COURSE_ICONS: IconName[] = [
  "flag",
  "layers",
  "book-open",
  "award",
  "calendar",
  "users",
  "user-check",
  "briefcase",
  "dollar-sign",
  "credit-card",
  "music",
  "mic",
  "camera",
  "image",
  "heart",
  "compass",
  "target",
  "trending-up",
  "map",
  "star",
];

/** Title, description, level, stream and icon — the course's own fields. */
export function CourseDetailsCard({
  course,
  themes,
  onChange,
}: {
  course: CourseEdit["course"];
  themes: Theme[];
  onChange: (next: CourseEdit["course"]) => void;
}) {
  const icons = COURSE_ICONS.includes(course.icon as IconName)
    ? COURSE_ICONS
    : [course.icon as IconName, ...COURSE_ICONS];
  return (
    <Card padding="md">
      <Text className="mb-3 text-base font-semibold text-ink">Course details</Text>
      <TextField
        label="Title"
        value={course.title}
        onChangeText={(title) => onChange({ ...course, title })}
      />
      <TextField
        label="Description"
        value={course.description}
        multiline
        numberOfLines={3}
        onChangeText={(description) => onChange({ ...course, description })}
      />
      <View className="mb-3 gap-1.5">
        <EditorLabel>Level</EditorLabel>
        <View className="flex-row flex-wrap gap-1.5">
          {LEVELS.map((l) => (
            <Pill
              key={l.value}
              label={l.label}
              selected={course.level === l.value}
              onPress={() => onChange({ ...course, level: l.value })}
            />
          ))}
        </View>
      </View>
      <Select
        label="Stream"
        value={course.themeKey}
        options={themes.map((t) => ({ value: t.key, label: t.title }))}
        onChange={(themeKey) =>
          onChange({ ...course, themeKey: themeKey as AcademyThemeKey })
        }
      />
      <View className="gap-1.5">
        <EditorLabel>Icon</EditorLabel>
        <RadioGroup
          accessibilityLabel="Course icon"
          horizontal
          className="flex-row flex-wrap gap-1.5"
        >
          {icons.map((name) => {
            const selected = course.icon === name;
            return (
              <Radio
                key={name}
                checked={selected}
                onSelect={() => onChange({ ...course, icon: name })}
                accessibilityLabel={`Icon: ${name}`}
                className={`h-10 w-10 items-center justify-center rounded-md border ${
                  selected
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-raised web:hover:bg-sunken"
                }`}
              >
                <Icon
                  name={name}
                  size={18}
                  color={selected ? colors.accent : colors.muted}
                />
              </Radio>
            );
          })}
        </RadioGroup>
      </View>
    </Card>
  );
}
