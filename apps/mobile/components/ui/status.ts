import type { EventStatus } from "@events-os/shared";
import type { BadgeTone } from "./Badge";

/** Map an event lifecycle status to a Badge tone. */
export function statusTone(status: EventStatus): BadgeTone {
  switch (status) {
    case "planning":
      return "warn";
    case "ready":
      return "accent";
    case "completed":
      return "success";
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}
