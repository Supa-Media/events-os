/**
 * The mailing list — the Marketing desk's view over `people`.
 *
 * The rules worth pinning are the ones a mistake is expensive in: a suppression
 * (an unsubscribe click, a bounce, a texted STOP) is never lifted from this
 * desk and never exported, even when someone is deliberately re-added;
 * `marketingOptOut` stops BOTH channels from one flag; a removal writes an SMS
 * opt-out but deliberately does NOT write an email suppression, because a
 * newsletter opt-out must not stop a donation receipt; the public signup is
 * write-only and cannot be used to probe who is in the database; and the whole
 * thing is chapter-scoped like the giving CRM.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** Give the test's user a seat carrying `capabilities` at `scope`. */
async function seedSeat(
  s: ChapterSetup,
  capabilities: string[],
  scope: "central" | Id<"chapters"> = "central",
): Promise<void> {
  const now = Date.now();
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seat Holder",
      email: "seat@publicworship.life",
      userId: s.userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: `test_marketing_seat_${scope}`,
      title: "Test Marketing Seat",
      chart: scope === "central" ? "central" : "chapter",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope,
      personId,
      createdAt: now,
    });
  });
}

/** A plain roster person with an address and a number. */
async function seedPerson(
  s: ChapterSetup,
  args: { name: string; email?: string; phone?: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: args.name,
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** Names on the list, for readable assertions. The seat holder seeded by
 *  `seedSeat` is a real person too, so tests filter it out rather than
 *  counting on it being absent. */
function names(rows: { name: string }[]): string[] {
  return rows.map((r) => r.name).filter((n) => n !== "Seat Holder");
}

describe("who is reachable", () => {
  test("a person with an address is on the list; one without is excluded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    await seedPerson(s, { name: "Reachable", email: "r@example.com" });
    await seedPerson(s, { name: "No address" });

    const on = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "email",
      view: "subscribed",
    });
    expect(names(on.rows)).toEqual(["Reachable"]);

    const off = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "email",
      view: "excluded",
    });
    expect(names(off.rows)).toEqual(["No address"]);
    expect(off.rows.find((r) => r.name === "No address")?.exclusions).toEqual([
      "no_address",
    ]);
  });

  test("opted out and suppressed are two different words, not one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    const optedOut = await seedPerson(s, {
      name: "Opted out",
      email: "opt@example.com",
    });
    await seedPerson(s, { name: "Bounced", email: "bounced@example.com" });
    await run(t, async (ctx) => {
      await ctx.db.patch(optedOut, { marketingOptOut: true });
      await ctx.db.insert("emailSuppressions", {
        email: "bounced@example.com",
        reason: "bounce",
        createdAt: Date.now(),
      });
    });

    const off = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "email",
      view: "excluded",
    });
    const byName = new Map(off.rows.map((r) => [r.name, r.exclusions]));
    expect(byName.get("Opted out")).toEqual(["opted_out"]);
    expect(byName.get("Bounced")).toEqual(["suppressed"]);
  });

  test("marketingOptOut stops the text list too, from one flag", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    const p = await seedPerson(s, { name: "Both", phone: "+12125550100" });
    await run(t, (ctx) => ctx.db.patch(p, { marketingOptOut: true }));

    const sms = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "sms",
      view: "subscribed",
    });
    expect(names(sms.rows)).toEqual([]);
  });

  test("a texted STOP shows as suppressed on the text list only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    await seedPerson(s, {
      name: "Stopped",
      email: "stop@example.com",
      phone: "+12125550111",
    });
    await run(t, (ctx) =>
      ctx.db.insert("smsOptOuts", {
        phone: "+12125550111",
        source: "stop_webhook",
        createdAt: Date.now(),
      }),
    );

    const sms = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "sms",
      view: "excluded",
    });
    expect(names(sms.rows)).toEqual(["Stopped"]);
    // Their EMAIL is untouched — a STOP is a promise about one channel.
    const email = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "email",
      view: "subscribed",
    });
    expect(names(email.rows)).toContain("Stopped");
  });
});

describe("adding and removing", () => {
  test("a view-only holder cannot add or remove", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    await expect(
      s.as.mutation(api.mailingList.addToList, {
        chapterId: s.chapterId,
        name: "Nope",
        email: "nope@example.com",
      }),
    ).rejects.toThrow(/permission to change the mailing list/i);
  });

  test("adding matches an existing person instead of forking them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const existing = await seedPerson(s, {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    const res = await s.as.mutation(api.mailingList.addToList, {
      chapterId: s.chapterId,
      name: "Ada L",
      email: "ada@example.com",
    });
    expect(res.isNew).toBe(false);
    expect(res.personId).toBe(existing);
  });

  test("adding with no chapter falls back to the caller's own", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    // The central lens has no chapter in hand. Refusing here would break the
    // fastest path there is — someone hands you their email at a gathering.
    const res = await s.as.mutation(api.mailingList.addToList, {
      name: "From the central lens",
      email: "central@example.com",
    });
    const person = await run(t, (ctx) =>
      ctx.db.get(res.personId as Id<"people">),
    );
    expect(person?.chapterId).toBe(s.chapterId);
  });

  test("adding records consent, and never overwrites an earlier yes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);

    const res = await s.as.mutation(api.mailingList.addToList, {
      chapterId: s.chapterId,
      name: "New Person",
      email: "new@example.com",
      consentSource: "Signed up at the Aug 14 gathering",
    });
    const personId = res.personId as Id<"people">;
    const first = await run(t, (ctx) => ctx.db.get(personId));
    expect(first?.consentSource).toBe("Signed up at the Aug 14 gathering");
    const firstAt = first?.consentedAt;

    await s.as.mutation(api.mailingList.addToList, {
      chapterId: s.chapterId,
      name: "New Person",
      email: "new@example.com",
      consentSource: "A weaker, later yes",
    });
    const second = await run(t, (ctx) => ctx.db.get(personId));
    expect(second?.consentSource).toBe("Signed up at the Aug 14 gathering");
    expect(second?.consentedAt).toBe(firstAt);
  });

  test("re-adding a SUPPRESSED address does not make them mailable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    await seedPerson(s, { name: "Complained", email: "spam@example.com" });
    await run(t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "spam@example.com",
        reason: "complaint",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.mailingList.addToList, {
      chapterId: s.chapterId,
      name: "Complained",
      email: "spam@example.com",
    });
    // The desk is told, plainly, that this did not do what it looks like.
    expect(res.stillSuppressed).toBe(true);

    const on = await s.as.query(api.mailingList.listMailingList, {
      chapterId: s.chapterId,
      channel: "email",
      view: "subscribed",
    });
    expect(names(on.rows)).not.toContain("Complained");
    // And the suppression row is untouched.
    const rows = await run(t, (ctx) =>
      ctx.db.query("emailSuppressions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("complaint");
  });

  test("a public signup can NOT lift an opt-out somebody at the org set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const staff = await seedPerson(s, {
      name: "Charisma Stevens",
      email: "charisma@publicworship.life",
    });
    await run(t, (ctx) => ctx.db.patch(staff, { marketingOptOut: true }));

    // Staff names are public on /team, and the matcher falls back to an exact
    // NAME match — so without the door distinction this post would silently
    // clear a colleague's opt-out AND write a stranger's address onto their row.
    await t.mutation(api.mailingList.subscribe, {
      name: "Charisma Stevens",
      email: "someone-else@example.com",
    });

    const after = await run(t, (ctx) => ctx.db.get(staff));
    expect(after?.marketingOptOut).toBe(true);
    expect(after?.email).toBe("charisma@publicworship.life");

    // The stranger became their own contact rather than being merged in.
    const all = await run(t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(all.filter((p) => p.name === "Charisma Stevens")).toHaveLength(2);
  });

  test("a public signup reverses the person's OWN unsubscribe, and nothing else", async () => {
    const t = newT();
    const s = await setupChapter(t);
    for (const [email, reason] of [
      ["unsub@example.com", "unsubscribe"],
      ["bounced@example.com", "bounce"],
      ["spam@example.com", "complaint"],
      ["blocked@example.com", "manual"],
    ] as const) {
      await seedPerson(s, { name: `Person ${email}`, email });
      await run(t, (ctx) =>
        ctx.db.insert("emailSuppressions", {
          email,
          reason,
          createdAt: Date.now(),
        }),
      );
      await t.mutation(api.mailingList.subscribe, {
        name: `Person ${email}`,
        email,
      });
    }

    const left = await run(t, (ctx) =>
      ctx.db.query("emailSuppressions").collect(),
    );
    // The unsubscribe is gone — that's the same human reversing the same
    // decision. A bounce is a fact about the mailbox, a complaint is a report
    // against us, and a manual suppression is a staff decision; none of the
    // three is a web form's to undo.
    expect(left.map((r) => r.email).sort()).toEqual([
      "blocked@example.com",
      "bounced@example.com",
      "spam@example.com",
    ]);
  });

  test("the DESK cannot lift any suppression, including an unsubscribe", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    await seedPerson(s, { name: "Left us", email: "left@example.com" });
    await run(t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "left@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.mailingList.addToList, {
      chapterId: s.chapterId,
      name: "Left us",
      email: "left@example.com",
    });
    expect(res.stillSuppressed).toBe(true);
    expect(await run(t, (ctx) => ctx.db.query("emailSuppressions").collect()))
      .toHaveLength(1);
  });

  test("removing sets the person-level stop and an SMS opt-out — but no email suppression", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const p = await seedPerson(s, {
      name: "Asked off",
      email: "off@example.com",
      phone: "+12125550122",
    });

    const res = await s.as.mutation(api.mailingList.removeFromList, {
      personId: p,
      note: "Asked at the Aug 14 gathering",
    });
    expect(res.smsOptOutRecorded).toBe(true);

    const person = await run(t, (ctx) => ctx.db.get(p));
    expect(person?.marketingOptOut).toBe(true);

    // NOT an email suppression: that ledger is deployment-wide and would stop
    // this person's donation receipts and RSVP confirmations too, which they
    // did not ask to stop.
    const suppressions = await run(t, (ctx) =>
      ctx.db.query("emailSuppressions").collect(),
    );
    expect(suppressions).toEqual([]);

    const optOuts = await run(t, (ctx) => ctx.db.query("smsOptOuts").collect());
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0].source).toBe("manual");
  });

  test("putting someone back clears the desk's own opt-out but never a real STOP", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const mine = await seedPerson(s, {
      name: "Mistake",
      email: "m@example.com",
      phone: "+12125550133",
    });
    const theirs = await seedPerson(s, {
      name: "Really stopped",
      phone: "+12125550144",
    });
    await run(t, async (ctx) => {
      await ctx.db.patch(theirs, { marketingOptOut: true });
      await ctx.db.insert("smsOptOuts", {
        phone: "+12125550144",
        source: "stop_webhook",
        createdAt: Date.now(),
      });
    });

    // A removal this desk made, undone.
    await s.as.mutation(api.mailingList.removeFromList, { personId: mine });
    const undo = await s.as.mutation(api.mailingList.restoreToList, {
      personId: mine,
    });
    expect(undo.smsStillOptedOut).toBe(false);
    expect(await run(t, (ctx) => ctx.db.query("smsOptOuts").collect())).toEqual([
      expect.objectContaining({ phone: "+12125550144" }),
    ]);

    // A STOP the person themselves sent survives, and says so.
    const cannot = await s.as.mutation(api.mailingList.restoreToList, {
      personId: theirs,
    });
    expect(cannot.smsStillOptedOut).toBe(true);
  });
});

describe("bulk actions", () => {
  test("a duplicated id in the selection counts once", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const a = await seedPerson(s, { name: "A", email: "a@example.com" });
    const b = await seedPerson(s, {
      name: "B",
      email: "b@example.com",
      phone: "+12125550201",
    });

    const res = await s.as.mutation(api.mailingList.removeManyFromList, {
      personIds: [a, b, a],
    });
    expect(res.removed).toBe(2);
    expect(res.smsOptOutsRecorded).toBe(1); // only B has a phone
    expect(res.skipped).toBe(0);
    expect((await run(t, (ctx) => ctx.db.get(a)))?.marketingOptOut).toBe(true);
  });

  test("a chapter-scoped holder skips rows outside their chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // CHAPTER scope, not central. A central `marketing.list.edit` holder
    // reaches every chapter by design (`canEditMailingList`), so this rule is
    // only observable from a chapter seat — the first draft of this test used
    // a central seat and asserted a skip that correctly never happened.
    await seedSeat(s, ["marketing.list.edit"], s.chapterId);
    const mine = await seedPerson(s, { name: "Mine", email: "mine@example.com" });

    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const outsider = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: otherChapterId,
        name: "Outsider",
        email: "out@example.com",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.mailingList.removeManyFromList, {
      personIds: [mine, outsider],
    });
    // Partial success, reported. Failing the whole call for one unreachable
    // row would make a mixed selection unusable; skipping silently would
    // report two removals when there was one.
    expect(res.removed).toBe(1);
    expect(res.skipped).toBe(1);
    expect((await run(t, (ctx) => ctx.db.get(mine)))?.marketingOptOut).toBe(true);
    expect(
      (await run(t, (ctx) => ctx.db.get(outsider)))?.marketingOptOut,
    ).toBeUndefined();
  });

  test("restoring many says how many are STILL unreachable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const clean = await seedPerson(s, { name: "Clean", email: "clean@example.com" });
    const bounced = await seedPerson(s, {
      name: "Bounced",
      email: "hard@example.com",
    });
    await run(t, async (ctx) => {
      await ctx.db.patch(clean, { marketingOptOut: true });
      await ctx.db.patch(bounced, { marketingOptOut: true });
      await ctx.db.insert("emailSuppressions", {
        email: "hard@example.com",
        reason: "bounce",
        createdAt: Date.now(),
      });
    });

    const res = await s.as.mutation(api.mailingList.restoreManyToList, {
      personIds: [clean, bounced],
    });
    // "restored 2" alone would be a lie by omission — one of them will still
    // never receive anything, and the desk has to be able to say so.
    expect(res.restored).toBe(2);
    expect(res.stillSuppressed).toBe(1);
  });

  test("a selection bigger than the cap is refused, never truncated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const one = await seedPerson(s, { name: "One", email: "one@example.com" });
    // "We removed the first 200 of your 500" is the worst outcome for an
    // operation whose whole point is deliberateness.
    await expect(
      s.as.mutation(api.mailingList.removeManyFromList, {
        personIds: Array.from({ length: 201 }, () => one),
      }),
    ).rejects.toThrow(/at most 200/i);
  });

  test("a view-only holder cannot bulk-remove", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]);
    const p = await seedPerson(s, { name: "Safe", email: "safe@example.com" });
    const res = await s.as.mutation(api.mailingList.removeManyFromList, {
      personIds: [p],
    });
    // Skipped rather than thrown: the gate is per-row, so a mixed selection
    // does the part it may and reports the rest.
    expect(res.removed).toBe(0);
    expect(res.skipped).toBe(1);
    expect((await run(t, (ctx) => ctx.db.get(p)))?.marketingOptOut).toBeUndefined();
  });
});

describe("export", () => {
  test("list access alone is not enough — it also needs data.export", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    await expect(
      s.as.query(api.mailingList.exportMailingList, {
        chapterId: s.chapterId,
        channel: "email",
      }),
    ).rejects.toThrow(/not export it/i);
  });

  test("only reachable people are exported", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit", "data.export"]);
    await seedPerson(s, { name: "Alice", email: "alice@example.com" });
    const bob = await seedPerson(s, { name: "Bob", email: "bob@example.com" });
    await seedPerson(s, { name: "Carol", email: "carol@example.com" });
    await run(t, async (ctx) => {
      await ctx.db.patch(bob, { marketingOptOut: true });
      await ctx.db.insert("emailSuppressions", {
        email: "carol@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      });
    });

    const { csv, rows } = await s.as.query(api.mailingList.exportMailingList, {
      chapterId: s.chapterId,
      channel: "email",
    });
    expect(csv).toContain("alice@example.com");
    expect(csv).not.toContain("bob@example.com");
    expect(csv).not.toContain("carol@example.com");
    // Alice plus the seat holder, who is also a reachable person.
    expect(rows).toBe(2);
  });
});

describe("the public signup", () => {
  test("creates a contact with consent recorded, no auth at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No identity — this is a stranger on the website.
    await t.mutation(api.mailingList.subscribe, {
      name: "Stranger",
      email: "stranger@example.com",
    });
    const person = await run(t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    const added = person.find((p) => p.name === "Stranger");
    expect(added).toBeDefined();
    expect(added?.consentedAt).toBeGreaterThan(0);
    expect(added?.consentSource).toBe("Public signup form");
    // A public signup is a CONTACT, never a roster teammate.
    expect(added?.isContactOnly).toBe(true);
  });

  test("a subscriber lands on the People roster, findable as a Contact", async () => {
    const t = newT();
    const s = await setupChapter(t);

    await t.mutation(api.mailingList.subscribe, {
      name: "Newsletter Signup",
      email: "signup@example.com",
    });

    // The founder's rule, pinned: "every people is the superset, and the
    // mailing list is the subset." A signup that only existed on the mailing
    // list would be a fifth place a contact can live, which is exactly what
    // the contact-consolidation work exists to prevent.
    const contacts = await s.as.query(api.people.listPaginated, {
      paginationOpts: { numItems: 50, cursor: null },
      persona: "contact",
    });
    expect(contacts.page.map((p: { name: string }) => p.name)).toContain(
      "Newsletter Signup",
    );

    // And they are a CONTACT, not a teammate — so the roster's default view
    // (persona "team") stays the team. This is why a subscriber is one click
    // away rather than on the front page of People, and it is deliberate: the
    // alternative floods the roster with every imported address.
    const team = await s.as.query(api.people.listPaginated, {
      paginationOpts: { numItems: 50, cursor: null },
      persona: "team",
    });
    expect(team.page.map((p: { name: string }) => p.name)).not.toContain(
      "Newsletter Signup",
    );
  });

  test("needs one of an email or a phone, and says which", async () => {
    const t = newT();
    await setupChapter(t);
    await expect(
      t.mutation(api.mailingList.subscribe, { name: "Nobody" }),
    ).rejects.toThrow(/email address or a phone number/i);
    await expect(
      t.mutation(api.mailingList.subscribe, {
        name: "Typo",
        email: "not-an-address",
      }),
    ).rejects.toThrow(/doesn't look right/i);
  });

  test("a known address returns the same nothing as a new one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Known", email: "known@example.com" });
    // The uniform `null` is what stops this endpoint being an oracle for
    // "is this person in your database?"
    await expect(
      t.mutation(api.mailingList.subscribe, {
        name: "Known",
        email: "known@example.com",
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(api.mailingList.subscribe, {
        name: "Brand New",
        email: "brandnew@example.com",
      }),
    ).resolves.toBeNull();
  });

  test("an unknown chapter slug falls back rather than failing the signup", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(api.mailingList.subscribe, {
      name: "Mistyped Link",
      email: "typo@example.com",
      chapterSlug: "no-such-chapter",
    });
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.map((r) => r.name)).toContain("Mistyped Link");
  });
});

describe("scope", () => {
  test("a chapter-scope holder cannot read another chapter's list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"], s.chapterId);

    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.query(api.mailingList.listMailingList, {
        chapterId: otherChapterId,
        channel: "email",
      }),
    ).rejects.toThrow(/don't have access to the mailing list/i);

    // Their own chapter is fine.
    await expect(
      s.as.query(api.mailingList.listMailingList, {
        chapterId: s.chapterId,
        channel: "email",
      }),
    ).resolves.toBeDefined();
  });
});
