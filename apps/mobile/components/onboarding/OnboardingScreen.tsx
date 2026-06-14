import { useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Card, Button, TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";

type ChapterId = string;

/**
 * First-run onboarding. Collects the user's name + phone (both required) and
 * has them pick a chapter from the list of active chapters, then calls
 * `profiles.completeOnboarding`. On success the `profiles.me` gate re-runs and
 * the app renders.
 */
export function OnboardingScreen() {
  const chapters = useQuery(api.profiles.listChapters);
  const complete = useMutation(api.profiles.completeOnboarding);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [chapterId, setChapterId] = useState<ChapterId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && phone.trim().length > 0 && !!chapterId;

  async function submit() {
    if (!canSubmit || !chapterId) return;
    setError(null);
    setSubmitting(true);
    try {
      await complete({
        name: name.trim(),
        phone: phone.trim(),
        chapterId: chapterId as any,
      });
      // No navigation needed — the profiles.me gate re-runs and renders the app.
    } catch (e) {
      setError(errorMessage(e, "Couldn't save. Please try again."));
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="w-full max-w-md px-6 py-8">
          <View className="mb-5 flex-row items-center gap-2.5">
            <View className="h-9 w-9 items-center justify-center rounded-md bg-accent">
              <Icon name="calendar" size={18} color="#FFFFFF" />
            </View>
            <View className="flex-row items-baseline gap-1">
              <Text className="font-display text-xl text-ink">Events</Text>
              <Text className="font-display text-xl text-accent">OS</Text>
            </View>
          </View>

          <Card padding="lg">
            <Text className="font-display text-2xl text-ink">Welcome</Text>
            <Text className="mb-5 mt-1 text-sm text-muted">
              Let's set up your profile and join a chapter.
            </Text>

            <TextField
              label="Name"
              value={name}
              onChangeText={(t) => {
                setName(t);
                if (error) setError(null);
              }}
              placeholder="Your full name"
              autoCapitalize="words"
              editable={!submitting}
            />

            <TextField
              label="Phone"
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                if (error) setError(null);
              }}
              placeholder="(555) 123-4567"
              keyboardType="phone-pad"
              autoComplete="tel"
              editable={!submitting}
            />

            {/* Chapter picker */}
            <Text className="mb-1.5 text-sm font-semibold text-ink">Chapter</Text>
            {chapters === undefined ? (
              <View className="items-center py-6">
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : chapters.length === 0 ? (
              <Text className="mb-3 text-sm text-muted">
                No chapters are available yet. Check back soon.
              </Text>
            ) : (
              <View className="mb-3 gap-2">
                {chapters.map((c) => (
                  <ChapterOption
                    key={c._id}
                    label={c.name}
                    selected={chapterId === c._id}
                    onPress={() => {
                      setChapterId(c._id);
                      if (error) setError(null);
                    }}
                  />
                ))}
              </View>
            )}

            {error ? (
              <View className="mb-3 flex-row items-center gap-1.5">
                <Icon name="alert-circle" size={14} color={colors.danger} />
                <Text className="flex-1 text-sm text-danger">{error}</Text>
              </View>
            ) : null}

            <Button
              title="Continue"
              onPress={submit}
              loading={submitting}
              disabled={!canSubmit}
              className="w-full"
            />
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * A selectable chapter row. The Card's own Pressable handles hover/pressed
 * feedback; the inner View owns layout + the selected treatment (web-safe — no
 * function-style Pressable styles).
 */
function ChapterOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Card
      onPress={onPress}
      padding="none"
      className={selected ? "border-accent" : ""}
    >
      <View
        className={`flex-row items-center justify-between gap-3 rounded-lg px-4 py-3 ${
          selected ? "bg-accent-soft" : ""
        }`}
      >
        <Text
          className={`text-base ${selected ? "font-semibold text-accent" : "text-ink"}`}
        >
          {label}
        </Text>
        {selected ? (
          <Icon name="check-circle" size={18} color={colors.accent} />
        ) : (
          <View className="h-4 w-4 rounded-full border border-border-strong" />
        )}
      </View>
    </Card>
  );
}
