import type { EventStatus } from "@events-os/shared";

type Tone = "neutral" | "accent" | "success" | "amber" | "danger";

/** Map an event lifecycle status to a Badge tone. */
export function statusTone(status: EventStatus): Tone {
  switch (status) {
    case "planning":
      return "amber";
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
