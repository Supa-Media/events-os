/**
 * The /subscribe form's controller.
 *
 * Same shape as `volunteer-signup.ts` and `team-apply.ts`, for the same
 * reasons: a same-origin POST under `/api/`, server errors surfaced verbatim as
 * human sentences, and a network failure that says so out loud rather than
 * pretending the signup arrived. Kept its own file because it posts a different
 * body to a different pipeline — one file pretending to do all three is the
 * first place they quietly diverge.
 *
 * The `?c=` on the URL rides along as `chapterSlug`, which is what makes a
 * per-chapter signup link work without a chapter picker on the form.
 */
const API = "/api/subscribe";

const form = document.querySelector<HTMLFormElement>("[data-subscribe-form]");
const statusEl = document.querySelector<HTMLElement>("[data-subscribe-status]");
const doneEl = document.querySelector<HTMLElement>("[data-subscribe-done]");
const submitBtn = document.querySelector<HTMLButtonElement>(
  "[data-subscribe-submit]",
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
  const name = String(data.get("name") ?? "").trim();
  const email = String(data.get("email") ?? "").trim();
  const phone = String(data.get("phone") ?? "").trim();

  if (!name) {
    setStatus("We need a name to put with it.", "error");
    form.querySelector<HTMLInputElement>("[name=name]")?.focus();
    return;
  }
  // Checked here as well as on the server so the person finds out before the
  // round-trip. The server's check is the one that counts.
  if (!email && !phone) {
    setStatus("An email address or a phone number, either one.", "error");
    form.querySelector<HTMLInputElement>("[name=email]")?.focus();
    return;
  }

  const chapterSlug = new URLSearchParams(window.location.search).get("c") ?? "";
  const payload = {
    name,
    email,
    phone,
    chapterSlug,
    website: String(data.get("website") ?? ""),
  };

  if (submitBtn) submitBtn.disabled = true;
  setStatus("Signing you up…");

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

// Marks this file a MODULE for TypeScript — see `volunteer-signup.ts`'s note.
export {};
