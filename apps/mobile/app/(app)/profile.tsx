import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, TextField, Field, Icon } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";

/**
 * Profile screen — edit name + phone (email is read-only, owned by auth) and
 * save via `profiles.updateProfile`. Reached from the sidebar / bottom-nav.
 */
export default function ProfileScreen() {
  const me = useQuery(api.profiles.me);
  const update = useMutation(api.profiles.updateProfile);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
    </Screen>
  );
}
