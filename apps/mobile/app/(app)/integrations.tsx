import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { Redirect } from "expo-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  AI_ENGINE_PROVIDERS,
  AI_ENGINE_PROVIDER_LABELS,
  type AiEngineProvider,
} from "@events-os/shared";
import { Screen, Card, Button, TextField, Icon } from "../../components/ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { TwilioUsageSummary } from "../../components/integrations/TwilioUsageSummary";

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
  const twilio = status?.twilio;
  const resend = status?.resend;
  const resendInbound = status?.resendInbound;
  const aiEngine = status?.aiEngine;

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

      <AiEngineCard aiEngine={aiEngine} loading={status === undefined} />
      <TwilioCard twilio={twilio} loading={status === undefined} />
      <TwilioUsageSummary />
      <ResendCard resend={resend} loading={status === undefined} />
      <ResendInboundCard
        resendInbound={resendInbound}
        loading={status === undefined}
      />
    </Screen>
  );
}

/**
 * AI engine card (switchable provider) — super-admins only. Picks the whole
 * app's AI provider (OpenRouter or Ollama), the Ollama key + base URL, the
 * GLOBAL default model (coding + the assistant), and a SEPARATE, DEDICATED
 * receipt-OCR model.
 *
 * The global model and the OCR model are deliberately independent settings
 * (RECEIPT QUALITY PR, fix 4): a general reasoning model tuned for
 * conversation (e.g. the owner's `gemma4:31b`) can silently degrade a receipt
 * read that a dedicated document-OCR model (`glm-ocr`, Ollama's default)
 * handles fine — so OCR never falls back to the global model, only to its own
 * per-provider default. See `receiptInbox.ts#resolveOcrModel`.
 *
 * The Ollama key is WRITE-ONLY (same discipline as the other cards: only a
 * configured/last4 status is ever shown). Both model pickers are fed by the
 * SAME LIVE provider model list (`listAvailableModels`) — every id shown
 * exactly as the API returns it (those are what the chat endpoint accepts) —
 * plus a free-text override for when the cloud list lags. "Test connection"
 * hits the provider's `/v1/models` so the owner can validate a live key from
 * the app.
 */
function AiEngineCard({
  aiEngine,
  loading,
}: {
  aiEngine:
    | {
        provider: AiEngineProvider;
        model: string | null;
        ocrModel: string | null;
        ollamaConfigured: boolean;
        ollamaLast4: string | null;
        ollamaBaseUrl: string | null;
        updatedAt: number | null;
      }
    | undefined;
  loading: boolean;
}) {
  const setEngine = useMutation(api.integrationSettings.setAiEngine);
  const setOllamaKey = useMutation(api.integrationSettings.setOllamaApiKey);
  const listModels = useAction(api.aiEngine.listAvailableModels);
  const testConnection = useAction(api.aiEngine.testAiConnection);

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [ocrModelInput, setOcrModelInput] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { ok: boolean; text: string } | null
  >(null);
  const [testing, setTesting] = useState(false);

  const provider = aiEngine?.provider ?? "openrouter";
  const isOllama = provider === "ollama";

  async function run(fn: () => Promise<unknown>, successMsg?: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      if (successMsg) setNotice(successMsg);
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the AI engine settings."));
    } finally {
      setBusy(false);
    }
  }

  async function loadModels() {
    setLoadingModels(true);
    setError(null);
    try {
      const res = await listModels({});
      if (res.ok) {
        setModels(res.models);
        if (res.models.length === 0) {
          setNotice("The provider returned no models.");
        }
      } else {
        setModels([]);
        setError(res.error ?? "Couldn't load models.");
      }
    } catch (e) {
      setError(errorMessage(e, "Couldn't load models."));
    } finally {
      setLoadingModels(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await testConnection({});
      setTestResult(
        res.ok
          ? {
              ok: true,
              text: `Connected — ${res.modelCount ?? 0} model(s) available.`,
            }
          : { ok: false, text: res.error ?? "Connection failed." },
      );
    } catch (e) {
      setTestResult({ ok: false, text: errorMessage(e, "Connection failed.") });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card padding="lg" className="mt-4">
      <View className="mb-3 flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="cpu" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">AI engine</Text>
          <Text className="text-xs text-muted">
            Global model powers finance auto-coding + the assistant; receipt OCR uses its own
            dedicated model below.
          </Text>
        </View>
      </View>

      {loading ? (
        <Text className="mb-3 text-xs text-muted">Loading status…</Text>
      ) : (
        <>
          {/* Provider toggle */}
          <Text className="mb-1.5 text-xs font-semibold text-muted">Provider</Text>
          <View className="mb-3 flex-row gap-2">
            {AI_ENGINE_PROVIDERS.map((p) => {
              const active = provider === p;
              return (
                <Pressable
                  key={p}
                  onPress={() =>
                    void run(async () => {
                      await setEngine({ provider: p });
                    }, `Switched to ${AI_ENGINE_PROVIDER_LABELS[p]}.`)
                  }
                  disabled={busy || active}
                  className={`flex-1 items-center rounded-lg border px-3 py-2 ${
                    active
                      ? "border-accent bg-raised"
                      : "border-border-strong bg-surface active:opacity-70"
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${active ? "text-accent" : "text-ink"}`}
                  >
                    {AI_ENGINE_PROVIDER_LABELS[p]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Ollama key + base URL (only relevant when Ollama is the provider,
              but shown so the owner can configure before switching). */}
          {isOllama ? (
            aiEngine?.ollamaConfigured ? (
              <View className="mb-2 flex-row items-center gap-1.5">
                <Icon name="check-circle" size={14} color={colors.success} />
                <Text className="text-sm text-ink">
                  Key configured — •••• {aiEngine.ollamaLast4}
                  {aiEngine.updatedAt
                    ? ` · updated ${formatDate(aiEngine.updatedAt)}`
                    : ""}
                </Text>
              </View>
            ) : (
              <View className="mb-2 flex-row items-center gap-1.5">
                <Icon name="alert-circle" size={14} color={colors.muted} />
                <Text className="text-sm text-muted">Ollama key not configured.</Text>
              </View>
            )
          ) : null}

          {isOllama ? (
            <>
              <TextField
                label="Ollama API key"
                value={apiKey}
                onChangeText={(t) => {
                  setApiKey(t);
                  if (error) setError(null);
                  if (notice) setNotice(null);
                }}
                placeholder={
                  aiEngine?.ollamaConfigured
                    ? "Paste a new key to replace it"
                    : "Paste your Ollama API key"
                }
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                hint="Stored server-side and never displayed again."
              />
              <View className="mb-3 flex-row gap-2">
                <Button
                  title="Save key"
                  icon="check"
                  onPress={() =>
                    void run(async () => {
                      await setOllamaKey({ apiKey: apiKey.trim() });
                      setApiKey("");
                    }, "Key saved.")
                  }
                  loading={busy}
                  disabled={!apiKey.trim() || busy}
                />
                {aiEngine?.ollamaConfigured ? (
                  <Button
                    title="Clear key"
                    icon="trash-2"
                    variant="danger"
                    onPress={() =>
                      void run(async () => {
                        await setOllamaKey({ apiKey: null });
                      }, "Key cleared.")
                    }
                    loading={busy}
                    disabled={busy}
                  />
                ) : null}
              </View>

              <TextField
                label="Ollama base URL (optional)"
                value={baseUrl}
                onChangeText={(t) => {
                  setBaseUrl(t);
                  if (error) setError(null);
                  if (notice) setNotice(null);
                }}
                placeholder={aiEngine?.ollamaBaseUrl ?? "https://ollama.com"}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                hint="Defaults to https://ollama.com. Point at a self-hosted Ollama if needed."
              />
              <View className="mb-3 flex-row gap-2">
                <Button
                  title="Save URL"
                  icon="check"
                  onPress={() =>
                    void run(async () => {
                      await setEngine({ baseUrl: baseUrl.trim() });
                      setBaseUrl("");
                    }, "Base URL saved.")
                  }
                  loading={busy}
                  disabled={!baseUrl.trim() || busy}
                />
                {aiEngine?.ollamaBaseUrl ? (
                  <Button
                    title="Reset URL"
                    icon="rotate-ccw"
                    variant="secondary"
                    onPress={() =>
                      void run(async () => {
                        await setEngine({ baseUrl: null });
                      }, "Base URL reset.")
                    }
                    loading={busy}
                    disabled={busy}
                  />
                ) : null}
              </View>
            </>
          ) : null}

          {/* Global model picker */}
          <View className="mb-1.5 flex-row items-center justify-between">
            <Text className="text-xs font-semibold text-muted">
              Global model
            </Text>
            <Pressable
              onPress={() => void loadModels()}
              disabled={loadingModels}
              className="active:opacity-70"
            >
              <Text className="text-2xs font-semibold text-accent">
                {loadingModels ? "Loading…" : "Load models"}
              </Text>
            </Pressable>
          </View>
          <Text className="mb-2 text-sm text-ink">
            {aiEngine?.model ? aiEngine.model : "Using each feature's default."}
          </Text>

          {models ? (
            models.length > 0 ? (
              <ScrollView
                style={{ maxHeight: 180 }}
                keyboardShouldPersistTaps="handled"
                className="mb-2 rounded-lg border border-border"
              >
                {models.map((id) => {
                  const active = aiEngine?.model === id;
                  return (
                    <Pressable
                      key={id}
                      onPress={() =>
                        void run(async () => {
                          await setEngine({ model: id });
                        }, `Model set to ${id}.`)
                      }
                      disabled={busy || active}
                      className={`flex-row items-center gap-2 px-2.5 py-2 active:opacity-70 ${
                        active ? "bg-raised" : ""
                      }`}
                    >
                      <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
                        {id}
                      </Text>
                      {active ? (
                        <Icon name="check" size={14} color={colors.accent} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null
          ) : null}

          {/* Free-text override (cloud lists can lag) */}
          <TextField
            label="Or enter a model id"
            value={modelInput}
            onChangeText={(t) => {
              setModelInput(t);
              if (error) setError(null);
              if (notice) setNotice(null);
            }}
            placeholder={isOllama ? "e.g. glm-ocr" : "e.g. openai/gpt-oss-120b:free"}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <View className="mb-3 flex-row gap-2">
            <Button
              title="Set model"
              icon="check"
              onPress={() =>
                void run(async () => {
                  await setEngine({ model: modelInput.trim() });
                  setModelInput("");
                }, "Model set.")
              }
              loading={busy}
              disabled={!modelInput.trim() || busy}
            />
            {aiEngine?.model ? (
              <Button
                title="Use default"
                icon="rotate-ccw"
                variant="secondary"
                onPress={() =>
                  void run(async () => {
                    await setEngine({ model: null });
                  }, "Reverted to the default model.")
                }
                loading={busy}
                disabled={busy}
              />
            ) : null}
          </View>

          {/* Receipt OCR model — SEPARATE from the global model above (fix 4:
              a general chat model must never silently become the OCR model). */}
          <View className="mb-1.5 mt-1 flex-row items-center justify-between">
            <Text className="text-xs font-semibold text-muted">Receipt OCR model</Text>
          </View>
          <Text className="mb-2 text-2xs text-faint">
            Global model above powers coding + the assistant. This one — separate — powers
            receipt OCR only. Defaults to {isOllama ? "glm-ocr" : "a cheap vision model"} when unset.
          </Text>
          <Text className="mb-2 text-sm text-ink">
            {aiEngine?.ocrModel ? aiEngine.ocrModel : `Using the default (${isOllama ? "glm-ocr" : "vision default"}).`}
          </Text>

          {models && models.length > 0 ? (
            <ScrollView
              style={{ maxHeight: 180 }}
              keyboardShouldPersistTaps="handled"
              className="mb-2 rounded-lg border border-border"
            >
              {models.map((id) => {
                const active = aiEngine?.ocrModel === id;
                return (
                  <Pressable
                    key={id}
                    onPress={() =>
                      void run(async () => {
                        await setEngine({ ocrModel: id });
                      }, `OCR model set to ${id}.`)
                    }
                    disabled={busy || active}
                    className={`flex-row items-center gap-2 px-2.5 py-2 active:opacity-70 ${
                      active ? "bg-raised" : ""
                    }`}
                  >
                    <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
                      {id}
                    </Text>
                    {active ? (
                      <Icon name="check" size={14} color={colors.accent} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          <TextField
            label="Or enter an OCR model id"
            value={ocrModelInput}
            onChangeText={(t) => {
              setOcrModelInput(t);
              if (error) setError(null);
              if (notice) setNotice(null);
            }}
            placeholder={isOllama ? "e.g. glm-ocr" : "e.g. google/gemini-2.0-flash-001"}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <View className="mb-3 flex-row gap-2">
            <Button
              title="Set OCR model"
              icon="check"
              onPress={() =>
                void run(async () => {
                  await setEngine({ ocrModel: ocrModelInput.trim() });
                  setOcrModelInput("");
                }, "OCR model set.")
              }
              loading={busy}
              disabled={!ocrModelInput.trim() || busy}
            />
            {aiEngine?.ocrModel ? (
              <Button
                title="Use default"
                icon="rotate-ccw"
                variant="secondary"
                onPress={() =>
                  void run(async () => {
                    await setEngine({ ocrModel: null });
                  }, "Reverted to the default OCR model.")
                }
                loading={busy}
                disabled={busy}
              />
            ) : null}
          </View>

          {/* Test connection */}
          <View className="flex-row items-center gap-2">
            <Button
              title="Test connection"
              icon="zap"
              variant="secondary"
              onPress={() => void runTest()}
              loading={testing}
              disabled={testing || busy}
            />
            {testResult ? (
              <View className="flex-1 flex-row items-center gap-1.5">
                <Icon
                  name={testResult.ok ? "check-circle" : "alert-circle"}
                  size={14}
                  color={testResult.ok ? colors.success : colors.danger}
                />
                <Text
                  className={`flex-1 text-xs ${testResult.ok ? "text-success" : "text-danger"}`}
                  numberOfLines={2}
                >
                  {testResult.text}
                </Text>
              </View>
            ) : null}
          </View>

          {error ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Icon name="alert-circle" size={14} color={colors.danger} />
              <Text className="flex-1 text-sm text-danger">{error}</Text>
            </View>
          ) : null}
          {notice ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Icon name="check-circle" size={14} color={colors.success} />
              <Text className="text-sm text-success">{notice}</Text>
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Twilio card (Attendance F) — the three SMS credentials for guest phone
 * verification + text blasts. The auth token is the secret and follows the
 * same write-only discipline as the Givebutter key: once saved, only a
 * configured/not-configured status + the account SID's last 4 are shown.
 * Saving requires all three; Clear wipes the whole trio.
 */
function TwilioCard({
  twilio,
  loading,
}: {
  twilio:
    | {
        configured: boolean;
        accountSidLast4: string | null;
        messagingServiceConfigured: boolean;
        updatedAt: number | null;
      }
    | undefined;
  loading: boolean;
}) {
  const setCreds = useMutation(api.integrationSettings.setTwilioCredentials);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const canSave =
    accountSid.trim() !== "" &&
    authToken.trim() !== "" &&
    messagingServiceSid.trim() !== "";

  function clearInputs() {
    setAccountSid("");
    setAuthToken("");
    setMessagingServiceSid("");
  }

  async function handleSave() {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      await setCreds({
        accountSid: accountSid.trim(),
        authToken: authToken.trim(),
        messagingServiceSid: messagingServiceSid.trim(),
      });
      clearInputs();
      setSavedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the Twilio credentials."));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setError(null);
    setClearing(true);
    try {
      await setCreds({
        accountSid: null,
        authToken: null,
        messagingServiceSid: null,
      });
      setSavedAt(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't clear the Twilio credentials."));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card padding="lg" className="mt-4">
      <View className="mb-3 flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="message-circle" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">Twilio (SMS)</Text>
          <Text className="text-xs text-muted">
            Powers guest phone verification and text blasts.
          </Text>
        </View>
      </View>

      {loading ? (
        <Text className="mb-3 text-xs text-muted">Loading status…</Text>
      ) : twilio?.configured ? (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="check-circle" size={14} color={colors.success} />
          <Text className="text-sm text-ink">
            Configured — SID •••• {twilio.accountSidLast4}
            {twilio.updatedAt ? ` · updated ${formatDate(twilio.updatedAt)}` : ""}
          </Text>
        </View>
      ) : (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="alert-circle" size={14} color={colors.muted} />
          <Text className="text-sm text-muted">Not configured.</Text>
        </View>
      )}

      <TextField
        label="Account SID"
        value={accountSid}
        onChangeText={(t) => {
          setAccountSid(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder={twilio?.configured ? "Paste a new SID to replace it" : "ACxxxxxxxx…"}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving && !clearing}
      />
      <TextField
        label="Auth token"
        value={authToken}
        onChangeText={(t) => {
          setAuthToken(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder="Paste your Twilio auth token"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving && !clearing}
        hint="Stored server-side and never displayed again."
      />
      <TextField
        label="Messaging Service SID"
        value={messagingServiceSid}
        onChangeText={(t) => {
          setMessagingServiceSid(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder="MGxxxxxxxx…"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving && !clearing}
        hint="An A2P-registered Messaging Service handles delivery + STOP replies."
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
          <Text className="text-sm text-success">Credentials saved.</Text>
        </View>
      ) : null}

      <View className="flex-row gap-2">
        <Button
          title="Save"
          icon="check"
          onPress={() => void handleSave()}
          loading={saving}
          disabled={!canSave || saving || clearing}
        />
        {twilio?.configured ? (
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
  );
}

/**
 * Resend card (own-key email integration) — lets a chapter send email from
 * its own Resend account/domain instead of the shared default (so mail
 * doesn't look like it comes from the framework's shared sender). The API
 * key follows the same write-only discipline as Givebutter/Twilio; the
 * from-address is NOT secret (it's the sender line every recipient already
 * sees), so it's shown in full and can be edited on its own once a key is
 * already saved — Save re-sends the key only when the field has something in
 * it, otherwise it updates just the from-address.
 */
function ResendCard({
  resend,
  loading,
}: {
  resend:
    | {
        configured: boolean;
        last4: string | null;
        fromAddress: string | null;
        updatedAt: number | null;
      }
    | undefined;
  loading: boolean;
}) {
  const setSettings = useMutation(api.integrationSettings.setResendSettings);
  const [apiKey, setApiKey] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromInitialized, setFromInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Prefill the from-address (not secret) once status loads, so a superuser
  // can see + tweak it without having to already know it or re-paste the key.
  useEffect(() => {
    if (!fromInitialized && resend !== undefined) {
      setFromInitialized(true);
      setFromAddress(resend.fromAddress ?? "");
    }
  }, [resend, fromInitialized]);

  const trimmedKey = apiKey.trim();
  const trimmedFrom = fromAddress.trim();
  const fromChanged = trimmedFrom !== (resend?.fromAddress ?? "");
  const canSave = trimmedKey !== "" || (!!resend?.configured && fromChanged);

  async function handleSave() {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      await setSettings({
        apiKey: trimmedKey === "" ? undefined : trimmedKey,
        fromAddress: trimmedFrom,
      });
      setApiKey("");
      setSavedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the Resend settings."));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setError(null);
    setClearing(true);
    try {
      await setSettings({ apiKey: null, fromAddress: null });
      setFromAddress("");
      setSavedAt(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't clear the Resend settings."));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card padding="lg" className="mt-4">
      <View className="mb-3 flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="mail" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">Resend (email)</Text>
          <Text className="text-xs text-muted">
            Send email from your own Resend account and domain instead of the
            shared default — e.g. Chapter OS &lt;os@publicworship.life&gt;.
          </Text>
        </View>
      </View>

      {loading ? (
        <Text className="mb-3 text-xs text-muted">Loading status…</Text>
      ) : resend?.configured ? (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="check-circle" size={14} color={colors.success} />
          <Text className="text-sm text-ink">
            Configured — •••• {resend.last4}
            {resend.fromAddress ? ` · from ${resend.fromAddress}` : ""}
            {resend.updatedAt ? ` · updated ${formatDate(resend.updatedAt)}` : ""}
          </Text>
        </View>
      ) : (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="alert-circle" size={14} color={colors.muted} />
          <Text className="text-sm text-muted">Not configured.</Text>
        </View>
      )}

      <TextField
        label="Resend API key"
        value={apiKey}
        onChangeText={(t) => {
          setApiKey(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder={
          resend?.configured ? "Paste a new key to replace it" : "Paste your Resend API key"
        }
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving && !clearing}
        hint="Stored server-side and never displayed again — the field above stays blank after saving."
      />
      <TextField
        label="From address"
        value={fromAddress}
        onChangeText={(t) => {
          setFromAddress(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder="Chapter OS <os@publicworship.life>"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving && !clearing}
        hint="Shown to every recipient — not secret. Leave blank to use the default sender."
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
          <Text className="text-sm text-success">Settings saved.</Text>
        </View>
      ) : null}

      <View className="flex-row gap-2">
        <Button
          title="Save"
          icon="check"
          onPress={() => void handleSave()}
          loading={saving}
          disabled={!canSave || saving || clearing}
        />
        {resend?.configured ? (
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
  );
}

/**
 * Resend inbound receipt webhook card — the Svix `whsec_…` signing secret for
 * `/resend/inbound` (see `http.ts`, `receiptInbox.ts`). Same write-only
 * discipline as the Givebutter key: settable in-app instead of only via the
 * deployment `RESEND_INBOUND_WEBHOOK_SECRET` env var, which the stored
 * setting takes precedence over.
 */
function ResendInboundCard({
  resendInbound,
  loading,
}: {
  resendInbound:
    | {
        configured: boolean;
        last4: string | null;
        updatedAt: number | null;
      }
    | undefined;
  loading: boolean;
}) {
  const setSecret = useMutation(
    api.integrationSettings.setResendInboundWebhookSecret,
  );
  const [secret, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function handleSave() {
    const trimmed = secret.trim();
    if (!trimmed) return;
    setError(null);
    setSaving(true);
    try {
      await setSecret({ secret: trimmed });
      setSecretValue("");
      setSavedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the webhook secret."));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setError(null);
    setClearing(true);
    try {
      await setSecret({ secret: null });
      setSavedAt(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't clear the webhook secret."));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card padding="lg" className="mt-4">
      <View className="mb-3 flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-mint">
          <Icon name="mail" size={14} color="#1F5A41" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">
            Receipt inbox (Resend)
          </Text>
          <Text className="text-xs text-muted">
            Verifies inbound receipt emails at /resend/inbound.
          </Text>
        </View>
      </View>

      {loading ? (
        <Text className="mb-3 text-xs text-muted">Loading status…</Text>
      ) : resendInbound?.configured ? (
        <View className="mb-3 flex-row items-center gap-1.5">
          <Icon name="check-circle" size={14} color={colors.success} />
          <Text className="text-sm text-ink">
            Configured — •••• {resendInbound.last4}
            {resendInbound.updatedAt
              ? ` · updated ${formatDate(resendInbound.updatedAt)}`
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
        label="Webhook signing secret"
        value={secret}
        onChangeText={(t) => {
          setSecretValue(t);
          if (error) setError(null);
          if (savedAt) setSavedAt(null);
        }}
        placeholder={
          resendInbound?.configured
            ? "Paste a new secret to replace it"
            : "whsec_…"
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
          <Text className="text-sm text-success">Webhook secret saved.</Text>
        </View>
      ) : null}

      <View className="flex-row gap-2">
        <Button
          title="Save"
          icon="check"
          onPress={() => void handleSave()}
          loading={saving}
          disabled={!secret.trim() || saving || clearing}
        />
        {resendInbound?.configured ? (
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
  );
}
