/**
 * The /careers/apply form's controller.
 *
 * Talks to the Convex backend over a same-origin relative fetch — on
 * publicworship.life pw-router proxies everything under `/api/` to Convex
 * (`infra/router/src/route.ts`), so the page never needs to know the backend's
 * origin. The authority on what's valid is `hiring.submitApplication`; the
 * checks here are a courtesy that saves a round trip, and every server error
 * comes back as a human sentence we show verbatim rather than a status code.
 *
 * Deliberately vanilla, like `blog-reactions.ts` and `collaborate.ts`: this
 * site ships no framework runtime, and an application form is the last place
 * to start.
 */
const API = "/api/careers/apply";

const form = document.querySelector<HTMLFormElement>("[data-apply-form]");
const statusEl = document.querySelector<HTMLElement>("[data-apply-status]");
const doneEl = document.querySelector<HTMLElement>("[data-apply-done]");
const submitBtn = document.querySelector<HTMLButtonElement>("[data-apply-submit]");

/** Fill the role this application is for from the query string, falling back
 *  to the general-interest door. The title is display-only; the SLUG is what
 *  the backend files the application under. */
function hydrateRole(): void {
  const params = new URLSearchParams(window.location.search);
  const slug = (params.get("role") ?? "").trim();
  const title = (params.get("title") ?? "").trim();

  const slugInput = document.querySelector<HTMLInputElement>("[data-apply-role-slug]");
  const titleInput = document.querySelector<HTMLInputElement>(
    "[data-apply-role-title-input]",
  );
  const titleEl = document.querySelector<HTMLElement>("[data-apply-role-title]");

  if (slugInput) slugInput.value = slug;
  if (titleInput) titleInput.value = title;
  // Only overwrite the heading when we actually have a title — the server-
  // rendered fallback already reads "General interest".
  if (titleEl && title) titleEl.textContent = title;
  if (title) document.title = `Apply · ${title} — Public Worship`;
}

function setStatus(message: string, tone: "info" | "error" = "info"): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className =
    tone === "error" ? "text-sm text-red-600" : "text-sm text-ink/70";
}

/** Gather `answers.<key>` fields into the nested shape the API expects. */
function collectAnswers(data: FormData): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (!key.startsWith("answers.")) continue;
    answers[key.slice("answers.".length)] = String(value);
  }
  return answers;
}

/** The first empty required field, so we can focus it and say which one it is
 *  rather than letting the server answer that question a second later. */
function firstMissing(): HTMLElement | null {
  const fields = form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "[required]",
  );
  for (const field of fields ?? []) {
    if (!field.value.trim()) return field;
  }
  return null;
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!form) return;

  const missing = firstMissing();
  if (missing) {
    missing.focus();
    missing.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("One more thing needed above.", "error");
    return;
  }

  const data = new FormData(form);
  const payload = {
    roleSlug: String(data.get("roleSlug") ?? ""),
    roleTitle: String(data.get("roleTitle") ?? ""),
    name: String(data.get("name") ?? ""),
    email: String(data.get("email") ?? ""),
    phone: String(data.get("phone") ?? ""),
    location: String(data.get("location") ?? ""),
    referredBy: String(data.get("referredBy") ?? ""),
    // One link per line — a textarea is kinder than four inputs, and the
    // server caps both the count and each length.
    links: String(data.get("links") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    website: String(data.get("website") ?? ""),
    answers: collectAnswers(data),
  };

  if (submitBtn) submitBtn.disabled = true;
  setStatus("Sending…");

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || body.error) {
      setStatus(
        body.error ?? "That didn't go through. Try again in a moment.",
        "error",
      );
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    form.classList.add("hidden");
    doneEl?.classList.remove("hidden");
    doneEl?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // Network-level failure: never silently swallow it — the person needs to
    // know their application did NOT arrive.
    setStatus(
      "We couldn't reach the server. Check your connection and try again — or email hello@publicworship.life.",
      "error",
    );
    if (submitBtn) submitBtn.disabled = false;
  }
}

function init(): void {
  if (!form) return;
  hydrateRole();
  form.addEventListener("submit", submit);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
