# Switchable AI engine (OpenRouter ↔ Ollama)

The whole app's AI runs through ONE OpenAI-compatible client
(`apps/convex/lib/aiEngine.ts`). The active provider, its key, and a global
default model are configured **in-app** (profile → Integrations, superuser
only) — no redeploy needed to switch.

Both OpenRouter and Ollama cloud speak the OpenAI chat-completions wire format,
so the provider only decides three things: the base URL, the auth header, and a
couple of request extras (OpenRouter adds `usage:{include:true}` + the
`HTTP-Referer`/`X-OpenRouter-Title` attribution headers; Ollama adds nothing).

## Switching providers

Integrations screen → **AI engine** card:

1. **Provider** — toggle between OpenRouter and Ollama. Absent setting =
   `openrouter` (full back-compat).
2. **Ollama API key** — write-only, exactly like the Givebutter/Twilio keys:
   once saved only a `configured · •••• last4` status is shown, never the key.
   Bearer auth against `https://ollama.com`.
3. **Ollama base URL** (optional) — defaults to `https://ollama.com`; set it to
   point at a self-hosted Ollama later. The engine appends `/v1/...`.
4. **Global model** — the default model every AI call site uses. Pick from the
   **live** provider model list (`Load models`), or type any id in the free-text
   field (cloud lists can lag). Model ids are shown/stored **exactly** as the API
   returns them (those are what the chat endpoint accepts).
5. **Test connection** — hits the provider's `/v1/models` and reports
   `Connected — N models` or the error inline. This is how you validate a live
   key from the app (the dev backend is proxy-blocked from the providers).

## Where the key comes from (stored-first → env fallback)

`integrationSettings.readAiEngineConfig` resolves per call:

| Provider   | Key source (in order)                          | Base URL |
| ---------- | ---------------------------------------------- | -------- |
| ollama     | stored `ollamaApiKey` → `OLLAMA_API_KEY` env   | stored `ollamaBaseUrl` → `OLLAMA_BASE_URL` env → `https://ollama.com` |
| openrouter | `OPENROUTER_API_KEY` env (never stored in-app) | fixed `https://openrouter.ai/api` |

No key for the active provider → every call **degrades gracefully** (a typed
error is logged with a human-readable reason; no crash), same as before.

## Model picking (precedence)

Per call: **explicit per-call override** > stored global `aiModel` >
per-provider default.

- OpenRouter default = the call site's existing env/hardcoded model
  (`RECEIPT_OCR_MODEL`, `OPENROUTER_MODEL`, `DEFAULT_AI_MODEL`).
- Ollama soft default = `glm-ocr` for receipt OCR, `gemma4` for coding + the
  assistant. These are **fallbacks only** — the live `/v1/models` list is
  authoritative. If a default id isn't in your account's list, the call surfaces
  a typed error **naming the model** ("Ollama returned 404 for model …"), so you
  immediately know to pick the right id from the dropdown.

## What follows the global setting

Every AI call site resolves the config per call, so OCR, coding, and the
assistant all follow the one global provider/model:

- **Receipt OCR** — `receiptInbox.ocrReceiptImage` (email pipeline,
  `receipts.processUploadedReceipt` upload, `smsReceipts` MMS).
- **Finance auto-coding** — `aiCoding.suggestCoding` /
  `suggestCodingSystem`. The `aiUsageEvents` audit trail is intact; on Ollama the
  row logs token counts with **$0 cost** (subscription — no per-call charge).
- **Assistant** — `aiActions.runAssistant` / `runDocAssistant` /
  `runInventoryAssistant` / `autofillItem`. OpenRouter behavior (retry, free-model
  fallback, prompt-cache, tool-calling) is unchanged; on Ollama tools pass through
  the same OpenAI-compat shape (a tool-less reply degrades exactly as a
  non-tool-calling model already did), and there is no free-model fallback chain.

## Retry hook (for a follow-up PR)

`lib/aiEngine.chatCompletion` takes the model in its request, and every call
site resolves `override > stored > default`. The retry-UI parameter is already
plumbed: `receipts.processUploadedReceipt({ receiptId, modelOverride })`,
`aiCoding.suggestCoding({ transactionId, modelOverride })`. Pass a different
model id as `modelOverride` to re-run one extraction/coding on a stronger model.
