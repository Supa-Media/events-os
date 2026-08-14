/**
 * HOW LONG THE APPROVE-UNDO TOAST STANDS, in seconds.
 *
 * Long enough to catch the tap you regret the instant you make it; short
 * enough that it is plainly a beat and not a pending state.
 *
 * THIS IS A COURTESY, NOT THE RULE. `transactionCodings.undoApproval` enforces
 * its own window server-side, off the approval's own `decidedAt`
 * (`UNDO_APPROVAL_WINDOW_MS` in `@events-os/shared`), because a paused tab or
 * a client with a stopped clock must not be able to widen it. This number has
 * to stay comfortably BELOW that one — a toast outliving the server's window
 * would spend its last seconds offering an Undo that throws — which
 * `undoWindow.test.ts` asserts rather than leaving to hope.
 *
 * It lives in its own plain module rather than in `CodingWorkbenchPanel.tsx`
 * only so that assert can import it: the panel pulls in `react-native`, which
 * the jest environment for these pure tests doesn't stand up.
 */
export const APPROVE_UNDO_SECONDS = 10;
