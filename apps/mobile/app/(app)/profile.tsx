import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, TextField, Field, Icon } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";

/** How each derived tier reads on the profile ("Access" line). */
const TIER_LABELS = {
  admin: "Chapter admin",
  lead: "Team lead",
  member: "Member",
  volunteer: "Volunteer",
} as const;

/**
 * Profile screen — edit name + phone (email is read-only, owned by auth),
 * save via `profiles.updateProfile`, and show WHO you are here: your chapter,
 * your derived access tier, and the "why do I see this" reasons behind it
 * (the identity-legibility decision D3 in the IA proposal).
 */
export default function ProfileScreen() {
  const me = useQuery(api.profiles.me);
  const org = useQuery(api.org.nav);
  const update = useMutation(api.profiles.updateProfile);
  const { signOut } = useAuthActions();
  const router = useRouter();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      // The (app) layout redirects to login once auth flips to signed-out.
      await signOut();
    } catch {
      setSigningOut(false);
    }
  }

  // Seed the form once the profile loads.
  useEffect(() => {
    if (me?.profile) {
      setName(me.profile.name);
      setPhone(me.profile.phone);
    }
  }, [me?.profile?.name, me?.profile?.phone]);

  if (me === undefined) return <Screen loading />;

  const dirty =
    !!me?.profile && (name !== me.profile.name || phone !== me.profile.phone);
  const canSave = dirty && name.trim().length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      await update({ name: name.trim(), phone: phone.trim() });
      setSavedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, "Couldn't save your profile."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen maxWidth={640}>
      <View className="mb-6">
        <Text className="font-display text-2xl text-ink">Profile</Text>
        <Text className="mt-1 text-sm text-muted">
          Update your name and phone number.
        </Text>
      </View>

      <Card padding="lg">
        {/* Email (read-only) */}
        <Field label="Email" hint="Your sign-in email can't be changed here.">
          <View className="flex-row items-center gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
            <Icon name="mail" size={15} color={colors.muted} />
            <Text className="flex-1 text-base text-muted" numberOfLines={1}>
              {me?.email ?? "—"}
            </Text>
          </View>
        </Field>

        <TextField
          label="Name"
          value={name}
          onChangeText={(t) => {
            setName(t);
            if (error) setError(null);
            if (savedAt) setSavedAt(null);
          }}
          placeholder="Your full name"
          autoCapitalize="words"
          editable={!saving}
        />

        <TextField
          label="Phone"
          value={phone}
          onChangeText={(t) => {
            setPhone(t);
            if (error) setError(null);
            if (savedAt) setSavedAt(null);
          }}
          placeholder="(555) 123-4567"
          keyboardType="phone-pad"
          autoComplete="tel"
          editable={!saving}
        />

        {error ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text className="flex-1 text-sm text-danger">{error}</Text>
          </View>
        ) : null}

        {savedAt && !dirty ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="check-circle" size={14} color={colors.success} />
            <Text className="text-sm text-success">Profile saved.</Text>
          </View>
        ) : null}

        <Button
          title="Save changes"
          onPress={save}
          loading={saving}
          disabled={!canSave}
        />
      </Card>

      {/* Chapter & access: which chapter you operate as, your derived tier,
          and why the app shows you what it shows. */}
      {org ? (
        <View className="mt-4">
          <Card padding="lg">
            <View className="mb-3 flex-row items-center gap-2">
              <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
                <Icon name="home" size={14} color="#1F5A41" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {org.chapterName ?? "No chapter yet"}
                </Text>
                <Text className="text-xs text-muted">
                  Access: {TIER_LABELS[org.tier]}
                </Text>
              </View>
            </View>
            {org.tierReasons.length > 0 ? (
              <View className="gap-1 border-t border-border pt-3">
                <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
                  Why you see what you see
                </Text>
                {org.tierReasons.map((reason, i) => (
                  <Text key={i} className="text-xs text-muted">
                    · {reason}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        </View>
      ) : null}

      {/* Super-admin tools */}
      {me?.isSuperuser ? (
        <View className="mt-4">
          <Button
            title="Manage guest access"
            icon="user-plus"
            variant="secondary"
            onPress={() => router.push("/guest-access")}
          />
        </View>
      ) : null}

      {/* Account actions */}
      <View className="mt-4">
        <Button
          title="Sign out"
          icon="log-out"
          variant="secondary"
          onPress={handleSignOut}
          loading={signingOut}
        />
      </View>
    </Screen>
  );
}
