import { describe, expect, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { buildOrgTree, type OrgTreePerson } from "./orgTree";

function person(
  id: string,
  name: string,
  effectiveManagerIds: string[],
  isTeamMember = true,
): OrgTreePerson {
  return {
    _id: id as Id<"people">,
    name,
    effectiveManagerIds: effectiveManagerIds as Id<"people">[],
    isTeamMember,
  };
}

describe("buildOrgTree", () => {
  test("a person with no manager is a root; reports nest under their manager", () => {
    const tree = buildOrgTree([
      person("ed", "Eli", []),
      person("dir", "Dana", ["ed"]),
      person("lead", "Lee", ["dir"]),
    ]);
    expect(tree.roots.map((p) => p._id)).toEqual(["ed"]);
    expect(tree.childrenOf.get("ed" as Id<"people">)?.map((p) => p._id)).toEqual(["dir"]);
    expect(tree.childrenOf.get("dir" as Id<"people">)?.map((p) => p._id)).toEqual(["lead"]);
    expect(tree.included).toHaveLength(3);
    expect(tree.teamSize.get("ed" as Id<"people">)).toBe(2);
  });

  test("a manager pointing outside the included roster makes the person a root, not dropped", () => {
    const tree = buildOrgTree([
      // "offRoster" is never itself in the array — its manager pointer is dangling.
      person("mia", "Mia", ["offRoster"]),
    ]);
    expect(tree.roots.map((p) => p._id)).toEqual(["mia"]);
    expect(tree.included.map((p) => p._id)).toEqual(["mia"]);
  });

  // PR #205 regression: prod-shaped seed with multiple central/chapter
  // multi-seat holders (see `orgSeatManagers.test.ts`'s convex-level version
  // of this same shape). Post-fix, `effectiveManagerIds` arriving from
  // `org.overview` is guaranteed cycle-free (server-side seniority tie-break
  // in `@events-os/shared`'s `deriveSeatManagerIds`) — this pins that the
  // CLIENT tree builder renders the full roster from that cycle-free input:
  // everyone appears exactly once, the ED is the sole root, no subtree is
  // silently dropped the way it was when a mutual manager edge left both
  // sides of the pair (and everything under them) unreachable from any root.
  test("prod-shaped roster: every person appears once, ED is the sole root, no dropped subtrees", () => {
    const ed = person("seyi", "Seyi", []); // ED — no manager, post-fix
    const financial = person("kansi", "Kansi", ["seyi"]);
    const music = person("austin", "Austin", ["seyi"]);
    const expansion = person("jesu", "Jesulayomi", ["seyi"]); // was mutually-cyclic pre-fix
    const marketing = person("charisma", "Charisma", ["seyi"]);
    const devDirector = person("aj", "AJ", ["seyi"]);
    const graphicDesigner = person("michaela", "Michaela", ["charisma"]);
    const marketingAssociate = person("carolyn", "Carolyn", ["charisma"]);
    const fundraisingAssociate = person("kaylamarie", "Kaylamarie", ["aj"]);
    const musicians = person("michael", "Michael", ["austin"]);
    const logistics = person("zay", "Zay", ["jesu"]);
    const organizer1 = person("org1", "Organizer One", ["jesu"]);
    const organizer2 = person("org2", "Organizer Two", ["jesu"]);
    const organizer3 = person("org3", "Organizer Three", ["jesu"]);
    const treasurer = person("treasurer", "Treasurer Tee", ["kansi"]);
    // Seatless, legacy-title fallback — the ONE row that survived pre-fix.
    const julie = person("julie", "Julie", []);

    const roster = [
      ed,
      financial,
      music,
      expansion,
      marketing,
      devDirector,
      graphicDesigner,
      marketingAssociate,
      fundraisingAssociate,
      musicians,
      logistics,
      organizer1,
      organizer2,
      organizer3,
      treasurer,
      julie,
    ];

    const tree = buildOrgTree(roster);

    // Every person in the roster is included and appears exactly once.
    expect(tree.included).toHaveLength(roster.length);
    const seen = new Set<string>();
    for (const p of tree.included) {
      expect(seen.has(p._id)).toBe(false);
      seen.add(p._id);
    }
    expect(seen.size).toBe(roster.length);

    // Julie (seatless, no manager) and the ED (no manager, post-fix) are the
    // only two people with no manager pointer — both roots, ED's subtree
    // dominates by size so it sorts first.
    expect(tree.roots.map((p) => p._id)).toEqual(["seyi", "julie"]);

    // No dropped subtrees: the ED's rollup reaches everyone except Julie.
    expect(tree.teamSize.get("seyi" as Id<"people">)).toBe(roster.length - 2);
  });
});
