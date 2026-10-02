/**
 * The Goals lesson: how the year plan (objectives and key results, the Goals
 * page) relates to the work that moves it (projects, events, duties). Its own
 * file because `works.ts` is at the size limit; it belongs to the Works theme
 * and is appended to the curriculum after Development so no existing section
 * renumbers.
 *
 * Marked optional for now so adding it doesn't reopen anyone's completed
 * Academy. Make it required once the plan is in use.
 */

import type { AcademySection, Course } from "../types";

export const GOALS_SECTIONS: Omit<AcademySection, "order">[] = [
  {
    slug: "works-goals-and-work",
    title: "Goals and the work behind them",
    subtitle: "The year plan keeps score; projects, events and duties do the work",
    minutes: 3,
    optional: true,
    blocks: [
      {
        kind: "p",
        text: "The **Goals** page holds the year plan: a mission, a few headline targets, and objectives. Each objective is judged by **key results**, the specific outcomes that tell us it happened.",
      },
      {
        kind: "rule",
        title: "A key result never holds tasks",
        text: "A key result is the score. The work that moves it lives in exactly one home elsewhere in the app, and links back to it.",
      },
      {
        kind: "table",
        headers: ["If the key result is…", "The work lives in"],
        rows: [
          ["Done once (launch the EP, publish the reel)", "One **project** on Work, linked to the key result"],
          ["A count of gatherings (15 WWS)", "**Events** on the calendar, counted automatically when completed"],
          ["Something every event does", "A row on the event **template**"],
          ["A rhythm (monthly newsletter)", "A **duty** on the seat that owns it"],
          ["Filling a seat", "The **org chart**; it counts as done once someone is seated"],
        ],
      },
      {
        kind: "p",
        text: "To link a project, open it and pick the key result under **Goal**. A project moves one key result at most. Work tied to no goal is fine; it just doesn't count toward the plan.",
      },
      {
        kind: "reveal",
        prompt: "Someone makes a key result called \"Eden 2027\" and lists permits and volunteers under it. What's wrong?",
        answer: "That's an event, not a score. Plan Eden as an event. The key result it moves is something like \"host four flagship events\", which counts Eden when it's done.",
      },
    ],
    quiz: [
      {
        prompt: "Where do the tasks for \"Launch the EP\" go?",
        options: [
          "In the key result's notes",
          "In one project linked to that key result",
          "In a duty on every seat",
          "Nowhere; key results track themselves",
        ],
        answerIndex: 1,
        explanation:
          "A key result is the score and never holds tasks. Done-once work is a project, and the project links to the key result it moves.",
      },
      {
        prompt: "How does \"Host 15 Worship With Strangers gatherings\" make progress?",
        options: [
          "Someone types the number in every week",
          "Completed WWS events are counted automatically",
          "Each chapter director emails the ED",
          "It only updates at the end of the year",
        ],
        answerIndex: 1,
        explanation:
          "A count of gatherings is measured from events: when an event of the chosen template is marked completed, the key result's count goes up.",
      },
      {
        prompt: "How many key results can one project move?",
        options: ["As many as it touches", "One at most", "Exactly two", "None; projects and goals aren't connected"],
        answerIndex: 1,
        explanation:
          "One primary key result per project keeps the plan honest: each piece of work has one place it's counted.",
      },
    ],
  },
];

export const GOALS_COURSES: Course[] = [
  {
    slug: "goals",
    themeKey: "works",
    title: "Goals",
    level: "beginner",
    audience: "team",
    description:
      "The year plan: objectives, key results, and where the work that " +
      "moves them lives.",
    icon: "target",
    moduleSlugs: ["works-goals-and-work"],
  },
];
