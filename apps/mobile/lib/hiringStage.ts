/**
 * Stage → chip tone for the Hiring desk, shared by the pipeline list and one
 * candidate's file so the same stage never reads as two different colors.
 *
 * Lives in `lib/` rather than in the pipeline route: a route file's job is to
 * be a screen, and importing one route module from another to borrow a helper
 * drags a whole screen's imports along with it.
 */
import type { BadgeTone } from "../components/ui";
import type { HiringStage } from "@events-os/shared";

/** Open stages warm up as they approach the decision; the closed ones read as
 *  outcomes rather than progress. */
export function stageTone(stage: HiringStage): BadgeTone {
  switch (stage) {
    case "applied":
      return "accent";
    case "reviewing":
      return "info";
    case "interview_heart":
    case "interview_role":
      return "lavender";
    case "trial":
      return "warn";
    case "decision":
      return "danger";
    case "placed":
      return "success";
    case "not_now":
      return "warn";
    default:
      return "neutral";
  }
}
