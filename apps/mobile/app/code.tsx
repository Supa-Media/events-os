/**
 * `/code` — the route. Thin by house convention (`personal-charges.tsx` does
 * the same): the screen itself is `components/finance/code/CodePage`, whose
 * module doc explains why this page lives outside `(app)` and why it needs no
 * finance seat.
 */
export { CodePage as default } from "../components/finance/code/CodePage";
