/**
 * Browser script for the reaction bar under a post (`blogPage.ts`).
 *
 * A port of `apps/landing/src/scripts/blog-reactions.ts`, which it replaces —
 * same endpoints, same payloads, same progressive-enhancement order:
 *
 *  1. The server renders the whole bar with zeroed counts, so the row is there
 *     on first paint and never pops in or shifts the page.
 *  2. This script fetches the real counts and marks the ones this browser
 *     already left.
 *  3. If the backend is unreachable, the bar disables itself rather than
 *     lying about a tap that never landed.
 *
 * `/api/blog/reactions` and `/api/blog/read` (`blogApiRoutes.ts`) are
 * UNCHANGED by the migration. They are same-origin from here in every
 * deployment: the page is served by this backend, so a relative fetch lands on
 * the same host whether a reader arrived via publicworship.life (pw-router
 * proxies `/api/*` here too) or straight at the .convex.site origin. That is
 * strictly simpler than the Astro version, which needed a
 * `PUBLIC_REACTIONS_API` escape hatch because `astro dev` on localhost had no
 * proxy in front of it — there is no such split any more, so the knob is gone.
 *
 * Written WITHOUT TEMPLATE LITERALS, like `givePageClient.ts`: this file's
 * contents are themselves interpolated into a template literal when the page
 * is assembled, and a backtick here would end that string early.
 */
export const BLOG_REACTIONS_JS = `
(function(){
  var API = '/api/blog/reactions';
  var READ_API = '/api/blog/read';
  var ACTOR_STORAGE_KEY = 'pw:blog:actor';

  function mintKey(){
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  /* This browser's key, created on first use. Storage can throw (Safari
     private browsing, cookies blocked, an embedded webview) and a thrown
     error here would take the whole bar down — so a failure falls back to a
     per-page-load key. That reader can still react; their toggle state just
     won't survive a reload. The key is not an identity: see
     lib/blogReactions.ts's module doc. */
  function actorKey(){
    try {
      var existing = window.localStorage.getItem(ACTOR_STORAGE_KEY);
      if (existing) return existing;
      var created = mintKey();
      window.localStorage.setItem(ACTOR_STORAGE_KEY, created);
      return created;
    } catch (e) {
      return mintKey();
    }
  }

  function setError(root, message){
    var slot = root.querySelector('[data-reaction-error]');
    if (slot) slot.textContent = message;
  }

  function buttons(root){
    return root.querySelectorAll('button[data-emoji]');
  }

  /* Paint counts and pressed state onto the already-rendered buttons. */
  function render(root, state){
    /* "· N readers" appended to the explainer line. Distinct browsers, not
       views (schema/blog.ts#blogReads); blank below 2 — "1 reader" on a page
       you yourself just opened is noise, not information. */
    var readersEl = root.querySelector('[data-reader-count]');
    if (readersEl && typeof state.readers === 'number') {
      readersEl.textContent = state.readers >= 2 ? '\\u00b7 ' + state.readers + ' readers' : '';
    }
    var mine = state.mine || [];
    var list = buttons(root);
    for (var i = 0; i < list.length; i++) {
      var button = list[i];
      var emoji = button.getAttribute('data-emoji') || '';
      var count = 0;
      var counts = state.counts || [];
      for (var j = 0; j < counts.length; j++) {
        if (counts[j].emoji === emoji) { count = counts[j].count; break; }
      }
      var countEl = button.querySelector('[data-count]');
      if (countEl) countEl.textContent = String(count);
      button.setAttribute('aria-pressed', mine.indexOf(emoji) === -1 ? 'false' : 'true');
    }
  }

  /* Turn the bar off for good — used when the backend can't be reached. */
  function disable(root){
    var list = buttons(root);
    for (var i = 0; i < list.length; i++) list[i].disabled = true;
  }

  function mount(root){
    var slug = root.getAttribute('data-slug');
    if (!slug) return;
    var actor = actorKey();
    var inFlight = false;

    /* Load current state via the read ping, which counts this browser as a
       reader (once, ever) and returns the same full state as a GET — so page
       load is a single round trip. Falls back to the plain GET if the ping
       fails (e.g. a POST-blocking proxy); a failure of both means no backend,
       so leave the zeroed bar in place, disabled, and say nothing: an error
       message about an internal API is noise to a reader. */
    fetch(READ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug, actorKey: actor })
    }).then(function(res){
      if (!res.ok) throw new Error('read ping failed');
      return res.json();
    }).catch(function(){
      return fetch(API + '?slug=' + encodeURIComponent(slug) + '&actorKey=' + encodeURIComponent(actor), {
        headers: { Accept: 'application/json' }
      }).then(function(res){
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }).then(function(state){
      render(root, state);
    }).catch(function(){
      disable(root);
    });

    root.addEventListener('click', function(event){
      var button = event.target && event.target.closest ? event.target.closest('button[data-emoji]') : null;
      if (!button || button.disabled) return;
      /* One at a time: two rapid taps on the same emoji would otherwise race
         to toggle the same row and land on whichever response came back
         last. */
      if (inFlight) return;
      inFlight = true;
      setError(root, '');
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug,
          emoji: button.getAttribute('data-emoji'),
          actorKey: actor
        })
      }).then(function(res){
        return res.json().then(function(body){ return { ok: res.ok, body: body }; });
      }).then(function(result){
        if (!result.ok || result.body.error) {
          setError(root, result.body.error || "Couldn't save that. Try again.");
        } else {
          render(root, result.body);
        }
      }).catch(function(){
        setError(root, "Couldn't save that — check your connection.");
      }).then(function(){
        inFlight = false;
      });
    });
  }

  var roots = document.querySelectorAll('[data-blog-reactions]');
  for (var i = 0; i < roots.length; i++) mount(roots[i]);
})();
`;
