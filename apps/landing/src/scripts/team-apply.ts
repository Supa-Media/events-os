/**
 * The /team/apply form's controller.
 *
 * Talks to the Convex backend over a same-origin relative fetch — on
 * publicworship.life pw-router proxies everything under `/api/` to Convex
 * (`infra/router/src/route.ts`), so the page never needs to know the backend's
 * origin. The authority on what's valid is `hiring.submitApplication`; the
 * checks here are a courtesy that saves a round trip, and every server error
 * comes back as a human sentence we show verbatim rather than a status code.
 *
 * Deliberately vanilla, like `collaborate.ts`: this
 * site ships no framework runtime, and an application form is the last place
 * to start.
 */
import {
  APPLICATION_TOGGLEABLE_FIELDS,
  APPLICATION_YES_NO,
  applicationQuestionCountPhrase,
  isYesNoQuestion,
  roleAcceptsApplications,
  type ApplicationFormConfig,
  type PublicJobListing,
} from "@events-os/shared/src/hiring";
import { roleDeadline } from "../lib/roles";

const API = "/api/team/apply";

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

/** One question's markup — the client twin of the `questions.map` in
 *  apply.astro, built with DOM calls so desk-written text is never parsed as
 *  HTML. */
function questionField(q: ApplicationFormConfig["questions"][number]): HTMLElement {
  const label = document.createElement("label");
  label.className = "block";

  const title = document.createElement("span");
  title.className = "text-sm font-semibold text-ink";
  title.textContent = q.label;
  if (!q.required) {
    const optional = document.createElement("span");
    optional.className = "font-normal text-ink/50";
    optional.textContent = " (optional)";
    title.appendChild(optional);
  }
  label.appendChild(title);

  if (q.help) {
    const help = document.createElement("span");
    help.className = "mt-1 block text-sm leading-relaxed text-ink/65";
    help.textContent = q.help;
    label.appendChild(help);
  }

  if (isYesNoQuestion(q)) {
    const select = document.createElement("select");
    select.name = `answers.${q.key}`;
    select.required = q.required;
    select.className =
      "mt-2 w-full rounded-xl border border-ink/20 bg-white px-4 py-3 text-base text-ink outline-none focus:border-red-500";
    const choices = [["", "Choose one"], ...APPLICATION_YES_NO.map((a) => [a, a])];
    for (const [value, text] of choices) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    label.appendChild(select);
    return label;
  }

  const area = document.createElement("textarea");
  area.name = `answers.${q.key}`;
  area.rows = q.maxLength > 1500 ? 6 : 4;
  area.maxLength = q.maxLength;
  area.required = q.required;
  area.className =
    "mt-2 w-full rounded-xl border border-ink/20 bg-white px-4 py-3 text-base leading-relaxed text-ink outline-none focus:border-red-500";
  label.appendChild(area);
  return label;
}

/** Swap the build-time default questions for the live form the desk edits
 *  (`GET /api/team/application`). Best-effort: if the fetch fails the defaults
 *  stay, and the server's own message covers any difference. Anything already
 *  typed into a question that survives the swap is carried over. */
async function hydrateQuestions(): Promise<void> {
  const wrap = document.querySelector<HTMLElement>("[data-apply-questions]");
  if (!wrap) return;

  let form: ApplicationFormConfig;
  try {
    const res = await fetch("/api/team/application", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    form = (await res.json()) as ApplicationFormConfig;
    if (!Array.isArray(form.questions) || form.questions.length === 0) return;
  } catch {
    return;
  }

  const typed = new Map<string, string>();
  const fields = () =>
    wrap.querySelectorAll<HTMLTextAreaElement | HTMLSelectElement>("textarea, select");
  for (const field of fields()) {
    if (field.value) typed.set(field.name, field.value);
  }
  wrap.replaceChildren(...form.questions.map(questionField));
  for (const field of fields()) {
    const value = typed.get(field.name);
    // A question that switched between written and yes/no keeps no answer:
    // a select silently ignores a value it has no option for.
    if (value) field.value = value;
  }

  const count = document.querySelector<HTMLElement>("[data-apply-question-count]");
  if (count) count.textContent = applicationQuestionCountPhrase(form.questions.length);

  for (const { key } of APPLICATION_TOGGLEABLE_FIELDS) {
    const required = form.requiredFields?.[key] === true;
    const field = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(`[data-apply-form] [name="${key}"]`);
    if (field) field.required = required;
    const optional = document.querySelector<HTMLElement>(
      `[data-optional-for="${key}"]`,
    );
    if (optional) optional.hidden = required;
  }
}

/** Under the heading, the seat's "Apply by Nov 1" line, when it has one. */
function showDeadline(roles: PublicJobListing[], appliedFor: string): void {
  const el = document.querySelector<HTMLElement>("[data-apply-deadline]");
  const role = roles.find((r) => r.slug === appliedFor);
  const deadline = role ? roleDeadline(role) : null;
  if (!el || !deadline) return;
  el.textContent = deadline;
  el.classList.replace("hidden", "inline-flex");
}

/** List every OTHER role that's taking applications as a checkbox, so someone
 *  applying for one seat can say which others they'd also take. Best-effort:
 *  no backend, no roles, or only the one they're applying for → the block
 *  stays hidden and the form works exactly as before. */
async function hydrateOtherRoles(): Promise<void> {
  const wrap = document.querySelector<HTMLElement>("[data-apply-other-roles]");
  const list = document.querySelector<HTMLElement>(
    "[data-apply-other-roles-list]",
  );
  if (!wrap || !list) return;
  const appliedFor = (
    new URLSearchParams(window.location.search).get("role") ?? ""
  )
    .trim()
    .toLowerCase();

  let roles: PublicJobListing[] = [];
  try {
    const res = await fetch("/api/team/roles", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { roles?: PublicJobListing[] };
    roles = Array.isArray(body.roles) ? body.roles : [];
  } catch {
    return;
  }

  showDeadline(roles, appliedFor);

  const others = roles.filter(
    (r) => roleAcceptsApplications(r.status) && r.slug !== appliedFor,
  );
  if (others.length === 0) return;

  for (const role of others) {
    const label = document.createElement("label");
    label.className = "flex items-start gap-3";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "mt-1 h-4 w-4 shrink-0 accent-red-500";
    box.dataset.otherRoleSlug = role.slug;
    box.dataset.otherRoleTitle = role.title;
    const text = document.createElement("span");
    text.className = "text-sm leading-relaxed text-ink";
    text.textContent = role.title;
    label.append(box, text);
    list.appendChild(label);
  }
  wrap.classList.remove("hidden");
}

/** The other roles they ticked, as `{ slug, title }`. */
function collectOtherRoles(): Array<{ slug: string; title: string }> {
  const boxes = document.querySelectorAll<HTMLInputElement>(
    "[data-other-role-slug]",
  );
  return [...boxes]
    .filter((b) => b.checked)
    .map((b) => ({
      slug: b.dataset.otherRoleSlug ?? "",
      title: b.dataset.otherRoleTitle ?? "",
    }));
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
  const fields = form?.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("[required]");
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
    gender: String(data.get("gender") ?? ""),
    socialHandle: String(data.get("socialHandle") ?? ""),
    referredBy: String(data.get("referredBy") ?? ""),
    // One link per line — a textarea is kinder than four inputs, and the
    // server caps both the count and each length.
    links: String(data.get("links") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    openToOtherRoles: data.get("openToOtherRoles") === "on",
    otherRoles: collectOtherRoles(),
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
  void hydrateQuestions();
  void hydrateOtherRoles();
  form.addEventListener("submit", submit);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
