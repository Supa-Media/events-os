/**
 * Roster seed data — Public Worship core team + vetted volunteers.
 *
 * The large data literals (transcribed from the team's Notion lists) used by the
 * `importRoster` mutation in `seed.ts`. Personas are not a rigid kind: core team
 * is flagged `isTeamMember`, vendors are signalled by a `usualRateUsd` (added
 * later), and everyone else is a volunteer — so the same person can vendor on
 * one event and volunteer on another.
 */

export const NY_CHAPTER_NAME = "The New York Chapter";

export type RosterStatus =
  | "active"
  | "inactive"
  | "transitioning_in"
  | "transitioning_out"
  | "unavailable";

export type RosterPerson = {
  name: string;
  phone?: string;
  email?: string;
  pwEmail?: string;
  role?: string;
  gender?: "male" | "female" | "na";
  status?: RosterStatus;
  skills?: string[];
  projects?: string[];
  commsPreferences?: string[];
  pocName?: string;
  notes?: string;
  isTeamMember?: boolean;
};

// Core team (Notion "Core Team"). isTeamMember = true; vetted.
export const CORE_TEAM: RosterPerson[] = [
  { name: "AJ", role: "Development & Partnerships Director", status: "active", email: "aj@publicworship.life", pwEmail: "aj@publicworship.life", phone: "+19174981017" },
  { name: "Austin Erickson", role: "Music Producer", status: "active", email: "austin12erickson@gmail.com", pwEmail: "austin@publicworship.life", phone: "+19492952793" },
  { name: "Bithja", role: "Worshipper / Music Coordinator", status: "active", email: "Bithja.music@gmail.com", pwEmail: "bithja@publicworship.life", phone: "+17186002855" },
  { name: "Carolyn Asante-Dartey", role: "Operations Coordinator", status: "transitioning_in", email: "cadartey@gmail.com", pwEmail: "carolyn@publicworship.life", phone: "+16692259191" },
  { name: "Charisma Stevens", role: "Social Media & Marketing Director", status: "active", email: "charismastev@gmail.com", pwEmail: "charisma@publicworship.life", phone: "+19802533721" },
  { name: "Dami", role: "Project Coordinator", status: "active", email: "Amiosunseemi@gmail.com", pwEmail: "dami@publicworship.life", phone: "+13474252819" },
  { name: "Ella Nnuji-John", role: "Partnerships & Expansion", status: "unavailable", email: "nnujiella@gmail.com", pwEmail: "ella@publicworship.life", phone: "+16018096623" },
  { name: "Idara Ojyede", role: "Events Coordinator", status: "inactive", email: "ojyiede@gmail.com", pwEmail: "idara@publicworship.life", phone: "+15164625626" },
  { name: "Johnnelle Villalona", role: "Worshipper", status: "active", email: "johnnellevillalona@gmail.com", pwEmail: "johnelle@publicworship.life", phone: "+13478625358" },
  { name: "Julie Nwaogbe", role: "Music Director", status: "transitioning_out", email: "jnwaogbe17@gmail.com", pwEmail: "julie@publicworship.life", phone: "+15162636386", commsPreferences: ["text"] },
  // LK Kupoluyi also appears on the volunteer list (same phone) as "LK" — the
  // volunteer skills/projects/notes are merged here so there is one record.
  { name: "LK Kupoluyi", role: "Events Director", status: "active", email: "jesulayomi3.0@gmail.com", pwEmail: "lkupo@publicworship.life", phone: "+17814925573", skills: ["Editing", "Videography", "Operations"], projects: ["Pop Up Worship", "Love Thy Neighbor"], notes: "Former PW Team" },
  { name: "Michael Reid", role: "Resident Musician", status: "active", email: "mareid707@gmail.com", pwEmail: "michael@publicworship.life", phone: "+19179517092" },
  { name: "Michaela Lawson", role: "Designer", status: "active", email: "michaelalwsn@gmail.com", pwEmail: "michaela@publicworship.life", phone: "+15166756378" },
  { name: "Sarah Gonzalez", role: "Events Coordinator", status: "active", email: "sarahgonz.pr@gmail.com", pwEmail: "sarah@publicworship.life", phone: "+19498128267" },
  { name: "Segun Olujide", role: "Accounting", status: "inactive", email: "segunolujide@gmail.com", pwEmail: "segun@publicworship.life", phone: "+12405501168" },
  { name: "Seyi Olujide", role: "Intern", status: "active", email: "seyi@supa.media", pwEmail: "seyi@publicworship.life", phone: "+12026150407", commsPreferences: ["slack", "call", "text"] },
  { name: "Zayy Powell", role: "Logistics Coordinator", status: "active", email: "powelltajzai@gmail.com", pwEmail: "zay@publicworship.life", phone: "+13472947095" },
].map((p) => ({ ...p, isTeamMember: true }) as RosterPerson);

// Vetted volunteers (Notion "Vetted Volunteer List"). isTeamMember unset.
export const VOLUNTEERS: RosterPerson[] = [
  { name: "Ahouma", gender: "female", phone: "+19144984147", status: "active", skills: ["Food/Catering", "Welcoming"], pocName: "Ami Osunseemi", projects: ["Eden"], notes: "Brings great energy and vibes; Sarya's fiancé" },
  { name: "Irene", gender: "female", phone: "+13013394518", status: "active", skills: ["Welcoming"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Jalen", gender: "male", phone: "+16786847415", status: "active", skills: ["Food/Catering"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Keyana", gender: "female", phone: "+16317085662", status: "active", skills: ["Decor", "Florist"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Kimberley", gender: "female", phone: "+16317085090", status: "active", skills: ["Florist", "Welcoming"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Phillip", gender: "male", phone: "+17702038597", status: "active", skills: ["Prayer"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Princess", gender: "female", phone: "+16235700676", status: "active", skills: ["Food/Catering"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Takida", gender: "female", phone: "+13475305748", status: "active", skills: ["Merch"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Joemo", gender: "male", phone: "+15104064955", status: "active", skills: ["Welcoming"], pocName: "Seyi Olujide", projects: ["Love Thy Neighbor"], notes: "Brings great energy and vibes; Sarya's fiancé" },
  { name: "Sarya", gender: "female", phone: "+17542157123", status: "active", skills: ["Welcoming"], pocName: "Segun Olujide", notes: "Joemo's fiancé" },
  { name: "Adam White", gender: "male", phone: "+14129539083", status: "active", skills: ["Welcoming", "Singing"], pocName: "Segun Olujide", projects: ["Love Thy Neighbor", "V2L Film"] },
  { name: "Chika", gender: "male", phone: "+19197177278", status: "active", skills: ["Welcoming"], pocName: "Seyi Olujide", projects: ["Love Thy Neighbor"] },
  { name: "Selly Gobeze", gender: "male", phone: "+14043371413", status: "active", skills: ["Welcoming"], pocName: "Seyi Olujide" },
  { name: "Magdala", gender: "female", phone: "+16469395747", status: "active", skills: ["Prayer"], pocName: "Segun Olujide" },
  { name: "Kansi", gender: "female", phone: "+18653478045", status: "inactive", skills: ["Operations", "Welcoming", "Prayer"], pocName: "Ami Osunseemi", projects: ["V2L Film"], notes: "Currently out of state" },
  { name: "Dee", gender: "female", phone: "+18064769022", status: "active", skills: ["Decor", "Welcoming"], pocName: "Ami Osunseemi", projects: ["Eden"] },
  { name: "Moses", gender: "male", phone: "+19084223817", status: "active", skills: ["Singing"], pocName: "Seyi Olujide", projects: ["Pop Up Worship"] },
  { name: "Temi", gender: "female", phone: "+16016183058", status: "active", skills: ["Decor", "Prayer", "Welcoming"], pocName: "Ami Osunseemi", projects: ["Eden", "Love Thy Neighbor"], notes: "Segun's wife" },
  { name: "Mariam", gender: "female", phone: "+12024990321", status: "active", skills: ["Operations", "Decor"], pocName: "Seyi Olujide", projects: ["Eden", "Pop The Balloon"], notes: "Seyi's sister" },
  { name: "Keianna", gender: "female", phone: "+13134022427", status: "active", skills: ["Welcoming", "Operations"], pocName: "Ojyiede", projects: ["Pop The Balloon"] },
  { name: "Cindy", gender: "female", phone: "+17185709487", status: "active", skills: ["Food/Catering", "Welcoming", "Decor"], pocName: "Seyi Olujide", projects: ["Eden"], notes: "Dinner party leader" },
];
