import subprocess, sys

REPO = "/Users/lilseyi/Code/events-os"
BASE = "bd9dc13"          # foundations commit
SRC  = "refactor/med-high-fixes"  # has all wave-1 + review fixes

def git(*args, check=True):
    r = subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        print("GIT FAIL:", args, "\n", r.stderr); sys.exit(1)
    return r.stdout.strip()

areas = {
  "backend": [
    "apps/convex/events.ts","apps/convex/eventTypes.ts","apps/convex/items.ts",
    "apps/convex/columns.ts","apps/convex/modules.ts","apps/convex/roles.ts",
    "apps/convex/roleAssignments.ts","apps/convex/engagements.ts","apps/convex/profiles.ts",
    "apps/convex/people.ts","apps/convex/storage.ts","apps/convex/seed.ts","apps/convex/docs.ts",
    "apps/convex/schema/docs.ts","apps/convex/schema/events.ts","apps/convex/schema/siteMap.ts",
  ],
  "ai": [
    "apps/convex/ai.ts","apps/convex/aiActions.ts",
    "apps/mobile/components/ai/AiAssistantPanel.tsx","apps/mobile/components/ai/DocAssistantPanel.tsx",
    "apps/mobile/components/ai/shared.tsx",
  ],
  "sitemap": [
    "apps/mobile/components/event/SiteMapEditor.tsx","apps/mobile/components/event/SiteMapPreview.tsx",
    "apps/mobile/components/event/SiteMapView.tsx",
  ],
  "grid": [
    "apps/mobile/components/grid/EditableGrid.tsx","apps/mobile/components/grid/cells.tsx",
    "apps/mobile/components/grid/useGridData.ts","apps/mobile/components/grid/columnRegistry.tsx",
  ],
  "crew-people": [
    "apps/mobile/components/event/CrewSections.tsx","apps/mobile/components/event/EngagementTable.tsx",
    "apps/mobile/components/event/engagementTypes.ts","apps/mobile/components/template/TemplateCrewCard.tsx",
    "apps/mobile/app/(app)/(tabs)/people.tsx","apps/mobile/components/ui/Readiness.tsx","apps/mobile/lib/theme.ts",
  ],
  "ux-screens": [
    "apps/mobile/app/_layout.tsx","apps/mobile/components/ui/AppShell.tsx",
    "apps/mobile/app/(app)/(tabs)/index.tsx","apps/mobile/app/(app)/(tabs)/templates.tsx",
    "apps/mobile/components/onboarding/OnboardingScreen.tsx","apps/mobile/app/(auth)/login.tsx",
    "apps/mobile/app/(app)/event/[id].tsx","apps/mobile/app/(app)/event/new.tsx",
    "apps/mobile/app/(app)/event/[id]/day-of.tsx","apps/mobile/app/(app)/event/[id]/packing.tsx",
    "apps/mobile/app/(app)/doc/[id].tsx","apps/mobile/app/(app)/template/[id].tsx",
    "apps/mobile/app/share/[id].tsx","apps/mobile/app/d/[shareId].tsx",
  ],
}

changed = set(git("diff","--name-only",f"{BASE}..{SRC}").splitlines())
assigned = [f for files in areas.values() for f in files]
assigned_set = set(assigned)

orphans = changed - assigned_set
typos   = assigned_set - changed
dupes   = [f for f in assigned if assigned.count(f) > 1]
if orphans or typos or dupes:
    print("COVERAGE ERROR")
    print(" orphans (changed, unassigned):", sorted(orphans))
    print(" typos (assigned, not changed):", sorted(typos))
    print(" dupes:", sorted(set(dupes)))
    sys.exit(1)
print(f"COVERAGE OK: {len(changed)} changed files == {len(assigned_set)} assigned across {len(areas)} areas")

# Create foundations branch
git("branch","-f","refactor/foundations",BASE)
print("created refactor/foundations @", BASE)

# Create area branches off BASE, slice in only that area's files from SRC
for name, files in areas.items():
    br = f"refactor/{name}"
    git("checkout","-q","-B",br,BASE)
    pathspecs = [f":(literal){f}" for f in files]
    git("checkout",SRC,"--",*pathspecs)
    git("add","-A")
    git("-c","commit.gpgsign=false","commit","-q","-m",f"slice: {name}")
    n = len(git("show","--stat","--name-only","--format=","HEAD").splitlines())
    print(f"  {br}: committed {n} files")

git("checkout","-q",SRC)
print("back on", git("rev-parse","--abbrev-ref","HEAD"))
