import { UNDO_APPROVAL_WINDOW_MS } from "@events-os/shared";
import { APPROVE_UNDO_SECONDS } from "./undoWindow";

/**
 * THE TOAST MUST NEVER OUTLIVE THE SERVER'S WINDOW.
 *
 * `transactionCodings.undoApproval` refuses past `UNDO_APPROVAL_WINDOW_MS`,
 * measured from the approval's own `decidedAt` — a server guarantee, not a UI
 * timer, so a paused tab can't widen it. The panel's countdown is a courtesy
 * on top of that.
 *
 * If somebody ever bumps the toast ("ten seconds is too quick") past the
 * server's window, the last stretch of the countdown would be offering an Undo
 * that throws `UNDO_WINDOW_CLOSED` — a live button that always fails, which is
 * the exact class of client/server disagreement the coding surfaces already
 * have scars from. This is the assert that catches it, in the package that
 * owns the toast.
 */
describe("the undo toast lives inside the server's window", () => {
  test("the countdown ends well before the mutation would refuse", () => {
    expect(APPROVE_UNDO_SECONDS * 1000).toBeLessThan(UNDO_APPROVAL_WINDOW_MS);
  });

  test("with room to spare — the gap absorbs a slow round trip, not a change of mind", () => {
    // At least a 2x margin. Tight enough that the server window stays "a
    // couple of minutes, for a mis-tap" rather than drifting into "reopen
    // whenever", and loose enough that a slow mutation landing just as the
    // toast fades still succeeds.
    expect(UNDO_APPROVAL_WINDOW_MS).toBeGreaterThanOrEqual(
      APPROVE_UNDO_SECONDS * 1000 * 2,
    );
  });
});
