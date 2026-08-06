import { useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Screen, Card, Button, TextField, Icon, EmptyState } from "../ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";

/**
 * DOOR ACCESS — the event's door-volunteer list, reached from the event
 * page's ⋯ tools menu. Grants check-in access for THIS event by email
 * (`doorAccess.grant`): an outside volunteer gets guest sign-in plus the
 * door-mode scanner and nothing else (see `DoorModeScreen`); a member's
 * email works too and simply adds the grant. Mirrors `guest-access.tsx`'s
 * form/list shape, scoped to one event instead of the global allowlist.
 */
export function DoorAccessScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = id as Id<"events">;
  const grants = useQuery(api.doorAccess.listForEvent, { eventId });
  const grant = useMutation(api.doorAccess.grant);
  const revoke = useMutation(api.doorAccess.revoke);

  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant() {
    if (!email.trim()) return;
    setError(null);
    setSaving(true);
    try {
      await grant({ eventId, email: email.trim(), note: note.trim() || undefined });
      setEmail("");
      setNote("");
    } catch (e) {
      setError(errorMessage(e, "Couldn't grant door access."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Door access" }} />
      <Screen maxWidth={640}>
        <View className="mb-6">
          <Text className="font-display text-2xl text-ink">Door access</Text>
          <Text className="mt-1 text-sm text-muted">
            Add the people working the door at this event. They'll sign in as a
            guest with this email and can only check tickets in for this event
            — nothing else. We'll email them when you add them.
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
            placeholder="volunteer@example.com"
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
            placeholder="e.g. Main entrance, first shift"
            editable={!saving}
          />

          {error ? (
            <View className="mb-3 flex-row items-center gap-1.5">
              <Icon name="alert-circle" size={14} color={colors.danger} />
              <Text className="flex-1 text-sm text-danger">{error}</Text>
            </View>
          ) : null}

          <Button
            title="Add to the door"
            icon="user-plus"
            onPress={handleGrant}
            loading={saving}
            disabled={!email.trim() || saving}
          />
        </Card>

        <View className="mt-6">
          <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
            Door list ({grants?.length ?? 0})
          </Text>

          {grants === undefined ? (
            <View className="items-center py-8">
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : grants.length === 0 ? (
            <EmptyState
              title="Nobody on the door yet"
              message="Add someone above to give them check-in access for this event."
            />
          ) : (
            <Card padding="none">
              {grants.map((g, i) => (
                <GrantRow
                  key={g._id}
                  grant={g}
                  isLast={i === grants.length - 1}
                  onRevoke={() => revoke({ grantId: g._id })}
                  onRestore={() => grant({ eventId, email: g.email })}
                />
              ))}
            </Card>
          )}
        </View>
      </Screen>
    </>
  );
}

/** One grant row: email + note, with a revoke/restore toggle. */
function GrantRow({
  grant,
  isLast,
  onRevoke,
  onRestore,
}: {
  grant: { _id: Id<"doorGrants">; email: string; note: string | null; isActive: boolean };
  isLast: boolean;
  onRevoke: () => Promise<unknown>;
  onRestore: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await (grant.isActive ? onRevoke() : onRestore());
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
          className={`text-sm font-medium ${grant.isActive ? "text-ink" : "text-muted line-through"}`}
          numberOfLines={1}
        >
          {grant.email}
        </Text>
        {grant.note ? (
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
            {grant.note}
          </Text>
        ) : null}
      </View>
      <Button
        title={grant.isActive ? "Revoke" : "Restore"}
        variant={grant.isActive ? "secondary" : "primary"}
        size="sm"
        loading={busy}
        onPress={toggle}
      />
    </View>
  );
}
