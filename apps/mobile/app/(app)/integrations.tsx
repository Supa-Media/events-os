import { useState } from "react";
import { View, Text } from "react-native";
import { Redirect } from "expo-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Screen, Card, Button, TextField, Icon } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";

/**
 * Integrations admin (Attendance E) — super-admins only. Lets a superuser set
 * the Givebutter API key IN-APP instead of only via the deployment
 * `GIVEBUTTER_API_KEY` env var (`givebutterSync.ts` prefers this stored
 * setting, falling back to the env var). Server-gated by `requireSuperuser`;
 * this screen also redirects away for non-superusers so it never dead-ends on
 * a permission error (mirrors `guest-access.tsx`).
 *
 * The key is WRITE-ONLY: once saved it's never shown again, only a
 * configured/not-configured status with its last 4 characters.
 */
export default function IntegrationsScreen() {
  const me = useQuery(api.profiles.me);
  const status = useQuery(
    api.integrationSettings.getIntegrationsStatus,
    me?.isSuperuser ? {} : "skip",
  );
  const setKey = useMutation(api.integrationSettings.setGivebutterApiKey);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (me === undefined) return <Screen loading />;
  if (!me?.isSuperuser) return <Redirect href="/" />;

  const givebutter = status?.givebutter;

  async function handleSave() {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setError(null);
    setSaving(true);
    try {
      await setKey({ apiKey: trimmed });
      setApiKey("");
      setSavedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the API key."));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setError(null);
    setClearing(true);
    try {
      await setKey({ apiKey: null });
      setSavedAt(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't clear the API key."));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Screen maxWidth={640}>
      <View className="mb-6">
        <Text className="font-display text-2xl text-ink">Integrations</Text>
        <Text className="mt-1 text-sm text-muted">
          Connect third-party services. Keys are stored server-side and are
          never shown again once saved.
        </Text>
      </View>

      <Card padding="lg">
        <View className="mb-3 flex-row items-center gap-2">
          <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
            <Icon name="key" size={14} color="#1F5A41" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">Givebutter</Text>
            <Text className="text-xs text-muted">
              Powers the ticket sync on events selling through Givebutter.
            </Text>
          </View>
        </View>

        {status === undefined ? (
          <Text className="mb-3 text-xs text-muted">Loading status…</Text>
        ) : givebutter?.configured ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="check-circle" size={14} color={colors.success} />
            <Text className="text-sm text-ink">
              Configured — •••• {givebutter.last4}
              {givebutter.updatedAt
                ? ` · updated ${formatDate(givebutter.updatedAt)}`
                : ""}
            </Text>
          </View>
        ) : (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="alert-circle" size={14} color={colors.muted} />
            <Text className="text-sm text-muted">Not configured.</Text>
          </View>
        )}

        <TextField
          label="Givebutter API key"
          value={apiKey}
          onChangeText={(t) => {
            setApiKey(t);
            if (error) setError(null);
            if (savedAt) setSavedAt(null);
          }}
          placeholder={
            givebutter?.configured
              ? "Paste a new key to replace it"
              : "Paste your Givebutter API key"
          }
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!saving && !clearing}
          hint="Stored server-side and never displayed again — the field above stays blank after saving."
        />

        {error ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text className="flex-1 text-sm text-danger">{error}</Text>
          </View>
        ) : null}

        {savedAt ? (
          <View className="mb-3 flex-row items-center gap-1.5">
            <Icon name="check-circle" size={14} color={colors.success} />
            <Text className="text-sm text-success">Key saved.</Text>
          </View>
        ) : null}

        <View className="flex-row gap-2">
          <Button
            title="Save"
            icon="check"
            onPress={() => void handleSave()}
            loading={saving}
            disabled={!apiKey.trim() || saving || clearing}
          />
          {givebutter?.configured ? (
            <Button
              title="Clear"
              icon="trash-2"
              variant="danger"
              onPress={() => void handleClear()}
              loading={clearing}
              disabled={saving || clearing}
            />
          ) : null}
        </View>
      </Card>
    </Screen>
  );
}
