import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useQuery, useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Card, Button, TextField, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";

type ChapterId = Id<"chapters">;

/**
 * First-run onboarding. Collects the user's name + phone (both required) and
 * has them pick a chapter from the list of active chapters, then calls
 * `profiles.completeOnboarding`. On success the `profiles.me` gate re-runs and
 * the app renders.
 */
export function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const { signOut } = useAuthActions();
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
        chapterId,
      });
      // No navigation needed — the profiles.me gate re-runs and renders the app.
    } catch (e) {
      setError(errorMessage(e, "Couldn't save. Please try again."));
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-surface">
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 16,
        }}
      >
        <View className="w-full max-w-md px-6 py-8">
          <View className="mb-5 flex-row items-center gap-2.5">
            <View className="h-9 w-9 items-center justify-center rounded-md bg-accent">
              <Icon name="calendar" size={18} color="#FFFFFF" />
            </View>
            <View className="flex-row items-baseline gap-1">
              <Text className="font-display text-xl text-ink">Chapter</Text>
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
                No chapters are available yet. Check back soon, or sign out and
                try a different account.
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

            {/* Only offer Continue when a chapter can actually be joined. With
                no chapters the form can't be submitted, so we lead with the
                sign-out escape instead of leaving the user on a dead end. */}
            {chapters && chapters.length === 0 ? null : (
              <Button
                title="Continue"
                onPress={submit}
                loading={submitting}
                disabled={!canSubmit}
                className="w-full"
              />
            )}

            <View className="mt-2 items-center">
              <Button
                title="Sign out"
                variant="ghost"
                size="sm"
                icon="log-out"
                onPress={() => signOut()}
                disabled={submitting}
              />
            </View>
          </Card>
        </View>
      </KeyboardAwareScrollView>
    </View>
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
