/**
 * The /serve signup form's controller.
 *
 * Same shape as `team-apply.ts` and for the same reasons — a same-origin POST
 * under `/api/`, server errors surfaced verbatim as human sentences, and a
 * network failure that says so out loud rather than pretending the signup
 * arrived. Kept separate from the application form's script because they post
 * different bodies to different pipelines, and one file pretending to do both
 * would be the first place they quietly diverge.
 */
const API = "/api/volunteer/signup";

const form = document.querySelector<HTMLFormElement>("[data-volunteer-form]");
const statusEl = document.querySelector<HTMLElement>("[data-volunteer-status]");
const doneEl = document.querySelector<HTMLElement>("[data-volunteer-done]");
const submitBtn = document.querySelector<HTMLButtonElement>(
  "[data-volunteer-submit]",
);

function setStatus(message: string, tone: "info" | "error" = "info"): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className =
    tone === "error" ? "text-sm text-red-600" : "text-sm text-ink/70";
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!form) return;

  const data = new FormData(form);
  const areas = data.getAll("areas").map((a) => String(a));

  for (const field of form.querySelectorAll<HTMLInputElement>("[required]")) {
    if (!field.value.trim()) {
      field.focus();
      setStatus("One more thing needed above.", "error");
      return;
    }
  }
  if (areas.length === 0) {
    setStatus(
      "Pick at least one thing you'd like to help with — “wherever you need me” counts.",
      "error",
    );
    return;
  }

  const payload = {
    name: String(data.get("name") ?? ""),
    email: String(data.get("email") ?? ""),
    phone: String(data.get("phone") ?? ""),
    location: String(data.get("location") ?? ""),
    availability: String(data.get("availability") ?? ""),
    message: String(data.get("message") ?? ""),
    website: String(data.get("website") ?? ""),
    areas,
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
    setStatus(
      "We couldn't reach the server. Check your connection and try again — or email hello@publicworship.life.",
      "error",
    );
    if (submitBtn) submitBtn.disabled = false;
  }
}

function init(): void {
  form?.addEventListener("submit", submit);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Marks this file a MODULE for TypeScript. Astro already bundles it as one
// (the page imports it), but a file with no top-level import/export reads as a
// global script to `tsc`, which then sees another page script's `form` /
// `statusEl` as a redeclaration of this one's. No runtime effect.
export {};
