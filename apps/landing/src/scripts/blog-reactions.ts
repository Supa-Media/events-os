/**
 * Client half of the emoji bar under each blog post
 * (src/components/blog/Reactions.astro).
 *
 * Talks to the Convex backend over a same-origin relative fetch: on
 * publicworship.life, pw-router proxies /api/* to Convex
 * (infra/router/src/route.ts), so no origin needs configuring and no CORS is
 * involved. Under `astro dev` on localhost there is no such proxy, so the
 * first fetch fails and the bar disables itself — reactions are simply not a
 * local-dev feature. Point PUBLIC_REACTIONS_API at a deployment's
 * .convex.site origin to exercise them locally.
 *
 * The reader is anonymous. `actorKey` is a random id minted once per browser
 * and kept in localStorage; it exists so a tap can be UNDONE and so a reload
 * doesn't double-count, and it is not an identity — see
 * apps/convex/lib/blogReactions.ts's module doc.
 */
const API_BASE =
  import.meta.env.PUBLIC_REACTIONS_API?.replace(/\/$/, "") ?? "";
const API = `${API_BASE}/api/blog/reactions`;
const READ_API = `${API_BASE}/api/blog/read`;

const ACTOR_STORAGE_KEY = "pw:blog:actor";

interface ReactionState {
  slug: string;
  counts: Array<{ emoji: string; count: number }>;
  mine: string[];
  readers?: number;
}

/**
 * This browser's key, created on first use.
 *
 * Storage can throw (Safari private browsing, cookies-blocked, an embedded
 * webview), and a thrown error here would take the whole bar down — so a
 * failure falls back to a per-page-load key. That reader can still react;
 * their toggle state just won't survive a reload.
 */
function actorKey(): string {
  const mint = () =>
    // 32 hex chars — inside the server's 8–64 charset-bounded window.
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  try {
    const existing = window.localStorage.getItem(ACTOR_STORAGE_KEY);
    if (existing) return existing;
    const created = mint();
    window.localStorage.setItem(ACTOR_STORAGE_KEY, created);
    return created;
  } catch {
    return mint();
  }
}

function setError(root: HTMLElement, message: string): void {
  const slot = root.querySelector<HTMLElement>("[data-reaction-error]");
  if (slot) slot.textContent = message;
}

/** Paint counts and pressed state onto the already-rendered buttons. */
function render(root: HTMLElement, state: ReactionState): void {
  // "· N readers" appended to the explainer line. Distinct browsers, not
  // views (apps/convex/schema/blog.ts#blogReads); left blank below 2 — "1
  // reader" on a page you yourself just opened is noise, not information.
  const readersEl = root.querySelector<HTMLElement>("[data-reader-count]");
  if (readersEl && typeof state.readers === "number") {
    readersEl.textContent =
      state.readers >= 2 ? `\u00b7 ${state.readers} readers` : "";
  }
  const mine = new Set(state.mine);
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "button[data-emoji]",
  )) {
    const emoji = button.dataset.emoji ?? "";
    const count = state.counts.find((c) => c.emoji === emoji)?.count ?? 0;
    const countEl = button.querySelector<HTMLElement>("[data-count]");
    if (countEl) countEl.textContent = String(count);
    button.setAttribute("aria-pressed", mine.has(emoji) ? "true" : "false");
  }
}

/** Turn the bar off for good — used when the backend can't be reached. */
function disable(root: HTMLElement): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "button[data-emoji]",
  )) {
    button.disabled = true;
  }
}

async function mount(root: HTMLElement): Promise<void> {
  const slug = root.dataset.slug;
  if (!slug) return;
  const actor = actorKey();

  // Load current state — via the read ping, which counts this browser as a
  // reader (once, ever) and returns the same full state as a GET, so page
  // load is a single round trip. Falls back to the plain GET if the ping
  // fails (e.g. a POST-blocking proxy); a failure of both means no backend —
  // leave the zeroed bar in place, disabled, and say nothing: an error
  // message about an internal API is noise to a reader.
  try {
    let state: ReactionState | null = null;
    try {
      const res = await fetch(READ_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, actorKey: actor }),
      });
      if (res.ok) state = (await res.json()) as ReactionState;
    } catch {
      // fall through to the GET
    }
    if (!state) {
      const res = await fetch(
        `${API}?slug=${encodeURIComponent(slug)}&actorKey=${encodeURIComponent(actor)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = (await res.json()) as ReactionState;
    }
    render(root, state);
  } catch {
    disable(root);
    return;
  }

  let inFlight = false;
  root.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      "button[data-emoji]",
    );
    if (!button || button.disabled) return;
    // One at a time: two rapid taps on the same emoji would otherwise race
    // to toggle the same row and land on whichever response came back last.
    if (inFlight) return;
    inFlight = true;
    setError(root, "");

    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          emoji: button.dataset.emoji,
          actorKey: actor,
        }),
      });
      const body = (await res.json()) as ReactionState & { error?: string };
      if (!res.ok || body.error) {
        setError(root, body.error ?? "Couldn't save that. Try again.");
      } else {
        render(root, body);
      }
    } catch {
      setError(root, "Couldn't save that — check your connection.");
    } finally {
      inFlight = false;
    }
  });
}

function init(): void {
  document
    .querySelectorAll<HTMLElement>("[data-blog-reactions]")
    .forEach((root) => void mount(root));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
