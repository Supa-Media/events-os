# Opening a role, and running the pipeline

For whoever owns people — today the Executive Director, and the People Director
once that seat is filled.

This is the operational companion to the Academy's `growing-the-team` course.
The course teaches the five steps; this guide is where the buttons are.

---

## 0 · Before anything: can you write the role down?

A seat is not ready to be posted until you can write:

- **the outcomes** it is accountable for — results, not activities — and, for
  each one, how you would both know it landed;
- **the decisions** its holder gets to make without asking;
- **what it is not** — the boundaries that stop half of every role dispute in a
  volunteer organization.

If those three won't come, the problem is the seat, not the writing. Delegating
a responsibility without outcomes, authority, and a definition of done is the
most reliable way to get it handed straight back.

---

## 1 · Publish the role

Roles are markdown in this repo, not rows in a database:

```
apps/landing/src/content/roles/<slug>.md
```

Copy an existing one (`people-director.md` is the fullest example) and fill in
every field. The collection's schema — `apps/landing/src/content/config.ts` — is
the template, and it is strict on purpose: a role that skips a section stops
being comparable to the others, and the whole reason we publish roles this way
is that a candidate can read two of them and tell the difference between the
*seats* rather than between the writers.

The fields that people find unfamiliar:

| Field | What goes in it |
|---|---|
| `outcomes` | Each with a `doneWhen`. Results and their definition of done |
| `authority` | What this person decides on their own |
| `notThisRole` | What the seat does not own |
| `hoursPerWeek` | The real number. It is a gate, so it goes on the page |
| `trialTrack` | `team_member` (≈4 weeks) or `director` (≈2 months) |
| `status` | `open` and `filling` take applications; `not_open` and `closed` render but point at general interest |

Open a PR. Merging to `main` deploys the landing site, and the role is live at
`/careers/<slug>`.

**Closing a role** is a status change (`closed`), not a deletion. A candidate
who bookmarked the page should find out what happened, and old applications
still point at the slug.

---

## 2 · Work the funnel in order

In-house → the volunteer interest pool → the public call → personal networks.
The order is the point: it stops a personal connection becoming a silent
shortcut around the process. Everything lands in the same place either way.

If you asked someone to apply, **re-file the source on their file** once it
arrives (the desk's "How they actually reached us" control). The form can only
ever say "public call," and the ordered search measures nothing if that is left
untrue.

---

## 3 · Run it from the Hiring desk

Chapter OS → **Hiring**. The numbers along the top are the desk's report card,
not decoration:

- **Past our promise** — applications older than 7 days that nobody has answered.
- **No owner** — files nobody has claimed. An unowned file aging is the loudest
  alarm here.
- **Trial reviews due** — a trial past its midpoint with no review filed.
- **Awaiting the call** — someone finished a trial and is waiting on you.

Zero is the right answer for all four.

On a candidate's file you can: take ownership, move the stage, file a rubric
review, start the trial, add notes, and — if you hold `hiring.approve` — make
the call.

### The rubric

The same five criteria at every interview and every trial review, in the order
that breaks ties: **character, communication, people skills, execution,
availability.** Skill can be trained; heart can't.

Leave a criterion unrated if you genuinely didn't see it. That is different from,
and more honest than, a low score, and the desk treats it that way.

Filing a second review for the same meeting replaces your own card — it does not
make you two reviewers.

### The trial

Pick the track, write the brief. A good brief names the real work, what "done"
looks like, and what they get to decide. Ask for the **playbook** as a
deliverable — the person doing the work writes it, which is both a better
playbook and a better read on them than any interview question.

The trial withholds what is hard to walk back: no posting to official accounts,
no budgets, no sensitive data, no team Slack yet. Say that out loud at the start;
discovering a boundary later feels like a slight, while hearing it up front is
just a boundary.

### The call

Three things the desk will not let you skip:

1. **A placement needs two people's reviews.** Not two reviews — two people.
2. **A not-now needs a revisit date.** Otherwise it is a no nobody had to say.
3. **Every close records a reason**, internally. It is never sent to the
   candidate, and in six months it is the only thing that makes re-opening the
   file honest.

The outcome message is drafted for you and fully editable. Edit it. A templated
message exists so nobody has to find the words for a hard no at 11pm — not so
that it goes out as a form letter.

---

## Who can do what

| | View | Run the pipeline | Make the call |
|---|---|---|---|
| Executive Director | ✓ | ✓ | ✓ |
| People Director (Expansion Director seat) | ✓ | ✓ | ✓ |
| Recruiting Associate | ✓ | ✓ | — |

The powers are `hiring.view`, `hiring.edit`, and `hiring.approve`
(`packages/shared/src/powers.ts`), granted on the seat chart and editable from
the org chart like any other power. All three are central-scope: the
organization runs one funnel with one standard, including for roles that will
sit in a chapter.

---

## Where the pieces live

| Piece | Path |
|---|---|
| The process, as constants | `packages/shared/src/hiring.ts` |
| Published roles | `apps/landing/src/content/roles/` |
| The public pages | `apps/landing/src/pages/careers/` |
| Application intake (public API) | `apps/convex/lib/careerApiRoutes.ts` → `hiring.submitApplication` |
| The desk's backend | `apps/convex/hiring.ts`, gated by `apps/convex/lib/hiringAccess.ts` |
| The desk's screens | `apps/mobile/app/(app)/hiring/` |
| What we teach about it | `packages/shared/src/academy/streams/management.ts` (`growing-the-team`) |
