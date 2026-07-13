import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, TextField, Icon, EmptyState } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import type { Doc } from "@events-os/convex/_generated/dataModel";

/**
 * Guest access admin — super-admins only. Grant or revoke app access for
 * individual off-domain emails (the `guestAllowlist`). A fresh grant emails the
 * guest. Server-gated by `requireSuperuser`; this screen also redirects away for
 * non-superusers so the UI never dead-ends on a permission error.
 */
export default function GuestAccessScreen() {
  const me = useQuery(api.profiles.me);
  const guests = useQuery(api.accessAllowlist.listGuests, me?.isSuperuser ? {} : "skip");
  const grant = useMutation(api.accessAllowlist.grantAccess);
  const revoke = useMutation(api.accessAllowlist.revokeAccess);

  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me === undefined) return <Screen loading />;
  if (!me?.isSuperuser) return <Redirect href="/" />;

  async function handleGrant() {
    if (!email.trim()) return;
    setError(null);
    setSaving(true);
    try {
      await grant({ email: email.trim(), note: note.trim() || undefined });
      setEmail("");
      setNote("");
    } catch (e) {
      setError(errorMessage(e, "Couldn't grant access."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen maxWidth={640}>
      <View className="mb-6">
        <Text className="font-display text-2xl text-ink">Guest access</Text>
        <Text className="mt-1 text-sm text-muted">
          Grant or revoke access for people without a @publicworship.life email.
          They sign in with the guest option and get a one-time code — and we'll
          email them when you grant access.
        </Text>
      </View>

      <Card padding="lg">
        <TextField
          label="Email"
          value={email}
          onChangeText={(t) => {
            setEmail(t);
            if (error) setError(null);
          }}
          placeholder="guest@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!saving}
          onSubmitEditing={handleGrant}
          returnKeyType="go"
        />
        <TextField
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="e.g. Guest speaker"
          editable={!saving}
        />

        {error ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text className="flex-1 text-sm text-danger">{error}</Text>
          </View>
        ) : null}

        <Button
          title="Grant access"
          icon="user-plus"
          onPress={handleGrant}
          loading={saving}
          disabled={!email.trim() || saving}
        />
      </Card>

      <View className="mt-6">
        <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
          Guests ({guests?.length ?? 0})
        </Text>

        {guests === undefined ? (
          <View className="items-center py-8">
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : guests.length === 0 ? (
          <EmptyState
            title="No guests yet"
            message="Add someone above to grant them access."
          />
        ) : (
          <Card padding="none">
            {guests.map((g, i) => (
              <GuestRow
                key={g._id}
                guest={g}
                isLast={i === guests.length - 1}
                onRevoke={() => revoke({ email: g.email })}
                onRestore={() => grant({ email: g.email })}
              />
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}

/** One allowlist row: email + note, with a revoke/restore toggle. */
function GuestRow({
  guest,
  isLast,
  onRevoke,
  onRestore,
}: {
  guest: Doc<"accessAllowlist">;
  isLast: boolean;
  onRevoke: () => Promise<unknown>;
  onRestore: () => Promise<unknown>;
}) {
  const active = guest.isActive !== false;
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await (active ? onRevoke() : onRestore());
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${
        isLast ? "" : "border-b border-border"
      }`}
    >
      <View className="flex-1">
        <Text
          className={`text-sm font-medium ${active ? "text-ink" : "text-muted line-through"}`}
          numberOfLines={1}
        >
          {guest.email}
        </Text>
        {guest.note ? (
          <Text className="text-xs text-muted" numberOfLines={1}>
            {guest.note}
          </Text>
        ) : null}
      </View>

      <Button
        title={active ? "Revoke" : "Restore"}
        variant={active ? "danger" : "secondary"}
        size="sm"
        onPress={toggle}
        loading={busy}
      />
    </View>
  );
}
