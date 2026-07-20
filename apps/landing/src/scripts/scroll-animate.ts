// Scroll-triggered entrance animations using IntersectionObserver.
//
// Any element marked with data-animate="<variant>" starts in the
// pre-state (set in CSS) and gets `data-animate-in` toggled true when
// it enters the viewport. CSS handles the actual transition.
//
// Honors prefers-reduced-motion: marks every element ready immediately.

const SELECTOR = "[data-animate]";

function init(): void {
  const targets = document.querySelectorAll<HTMLElement>(SELECTOR);
  if (targets.length === 0) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    targets.forEach((el) => el.setAttribute("data-animate-in", "true"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.setAttribute("data-animate-in", "true");
          observer.unobserve(entry.target);
        }
      }
    },
    {
      rootMargin: "0px 0px -10% 0px",
      threshold: 0.05,
    }
  );

  targets.forEach((el) => observer.observe(el));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
