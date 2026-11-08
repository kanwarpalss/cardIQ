// Catalog of the loyalty programs Indian card points can reach, plus the few
// genuine program-to-program "bridges" between them.
//
// Why bridges are listed separately: airline miles almost never move between
// airlines. "Axis → Aeroplan → Miles & More" is not a transfer — Aeroplan miles
// BOOK Lufthansa seats, they don't become Miles & More miles. The only real
// onward moves are the Avios family (one currency shared by several airlines)
// and hotel points converting into airline miles. Anything not in BRIDGES must
// never be drawn as a second hop.

export type Alliance = "star" | "oneworld" | "skyteam" | "none";
export type ProgramKind = "airline" | "hotel";

export type Program = {
  key: string;
  name: string;
  /** 2–3 letter monogram for tiles (airline IATA code where there is one). */
  code: string;
  kind: ProgramKind;
  /** Airlines only. Hotels have no alliance. */
  alliance?: Alliance;
  /** What the program calls its currency — "Avios", "miles", "points". */
  unit: string;
  /** Lower-case words or phrases that identify this program in a free-text
   *  loyalty_accounts.program_name (e.g. "KrisFlyer Singapore Airlines").
   *  Matched as whole words, so avoid bare generic words ("united",
   *  "virgin", "qatar") that other brands also use. */
  aliases: string[];
};

const P = (p: Program) => p;

export const PROGRAMS = {
  // ── Star Alliance ─────────────────────────────────────────────────────────
  krisflyer: P({ key: "krisflyer", name: "Singapore KrisFlyer", code: "SQ", kind: "airline", alliance: "star", unit: "miles", aliases: ["krisflyer", "singapore airlines"] }),
  aeroplan: P({ key: "aeroplan", name: "Air Canada Aeroplan", code: "AC", kind: "airline", alliance: "star", unit: "points", aliases: ["aeroplan", "air canada"] }),
  united: P({ key: "united", name: "United MileagePlus", code: "UA", kind: "airline", alliance: "star", unit: "miles", aliases: ["mileageplus", "united airlines"] }),
  turkish: P({ key: "turkish", name: "Turkish Miles&Smiles", code: "TK", kind: "airline", alliance: "star", unit: "miles", aliases: ["miles & smiles", "turkish airlines"] }),
  miles_and_more: P({ key: "miles_and_more", name: "Lufthansa Miles & More", code: "LH", kind: "airline", alliance: "star", unit: "miles", aliases: ["miles & more", "miles and more", "lufthansa"] }),
  air_india: P({ key: "air_india", name: "Air India Maharaja Club", code: "AI", kind: "airline", alliance: "star", unit: "points", aliases: ["maharaja", "air india", "flying returns"] }),
  thai: P({ key: "thai", name: "Thai Royal Orchid Plus", code: "TG", kind: "airline", alliance: "star", unit: "miles", aliases: ["royal orchid", "thai airways"] }),
  eva: P({ key: "eva", name: "EVA Infinity MileageLands", code: "BR", kind: "airline", alliance: "star", unit: "miles", aliases: ["infinity mileagelands", "eva air"] }),
  ethiopian: P({ key: "ethiopian", name: "Ethiopian ShebaMiles", code: "ET", kind: "airline", alliance: "star", unit: "miles", aliases: ["shebamiles", "ethiopian airlines"] }),
  lifemiles: P({ key: "lifemiles", name: "Avianca LifeMiles", code: "AV", kind: "airline", alliance: "star", unit: "miles", aliases: ["lifemiles", "avianca"] }),

  // ── oneworld ──────────────────────────────────────────────────────────────
  qatar_avios: P({ key: "qatar_avios", name: "Qatar Privilege Club", code: "QR", kind: "airline", alliance: "oneworld", unit: "Avios", aliases: ["privilege club", "qatar airways"] }),
  ba_avios: P({ key: "ba_avios", name: "British Airways Club", code: "BA", kind: "airline", alliance: "oneworld", unit: "Avios", aliases: ["british airways", "executive club", "ba club"] }),
  iberia: P({ key: "iberia", name: "Iberia Club", code: "IB", kind: "airline", alliance: "oneworld", unit: "Avios", aliases: ["iberia"] }),
  finnair: P({ key: "finnair", name: "Finnair Plus", code: "AY", kind: "airline", alliance: "oneworld", unit: "Avios", aliases: ["finnair"] }),
  asia_miles: P({ key: "asia_miles", name: "Cathay Asia Miles", code: "CX", kind: "airline", alliance: "oneworld", unit: "miles", aliases: ["asia miles", "cathay"] }),
  jal: P({ key: "jal", name: "JAL Mileage Bank", code: "JL", kind: "airline", alliance: "oneworld", unit: "miles", aliases: ["mileage bank", "jal", "japan airlines"] }),
  qantas: P({ key: "qantas", name: "Qantas Frequent Flyer", code: "QF", kind: "airline", alliance: "oneworld", unit: "points", aliases: ["qantas"] }),
  aadvantage: P({ key: "aadvantage", name: "American AAdvantage", code: "AA", kind: "airline", alliance: "oneworld", unit: "miles", aliases: ["aadvantage", "american airlines"] }),

  // ── SkyTeam ───────────────────────────────────────────────────────────────
  flying_blue: P({ key: "flying_blue", name: "Air France-KLM Flying Blue", code: "AF", kind: "airline", alliance: "skyteam", unit: "miles", aliases: ["flying blue", "air france", "klm"] }),
  lotusmiles: P({ key: "lotusmiles", name: "Vietnam Lotusmiles", code: "VN", kind: "airline", alliance: "skyteam", unit: "miles", aliases: ["lotusmiles", "vietnam airlines"] }),
  virgin: P({ key: "virgin", name: "Virgin Atlantic Flying Club", code: "VS", kind: "airline", alliance: "skyteam", unit: "points", aliases: ["flying club", "virgin atlantic"] }),

  // ── No alliance ───────────────────────────────────────────────────────────
  etihad: P({ key: "etihad", name: "Etihad Guest", code: "EY", kind: "airline", alliance: "none", unit: "miles", aliases: ["etihad"] }),
  airasia: P({ key: "airasia", name: "AirAsia Rewards", code: "AK", kind: "airline", alliance: "none", unit: "points", aliases: ["airasia"] }),
  hainan: P({ key: "hainan", name: "Hainan Fortune Wings", code: "HU", kind: "airline", alliance: "none", unit: "points", aliases: ["fortune wings", "hainan airlines"] }),
  spicejet: P({ key: "spicejet", name: "SpiceJet SpiceClub", code: "SG", kind: "airline", alliance: "none", unit: "points", aliases: ["spiceclub", "spicejet"] }),
  indigo: P({ key: "indigo", name: "IndiGo BluChip", code: "6E", kind: "airline", alliance: "none", unit: "BluChips", aliases: ["bluchip", "indigo"] }),

  // ── Hotels ────────────────────────────────────────────────────────────────
  accor: P({ key: "accor", name: "Accor ALL", code: "ALL", kind: "hotel", unit: "points", aliases: ["accor", "live limitless"] }),
  marriott: P({ key: "marriott", name: "Marriott Bonvoy", code: "MB", kind: "hotel", unit: "points", aliases: ["marriott", "bonvoy"] }),
  hilton: P({ key: "hilton", name: "Hilton Honors", code: "HH", kind: "hotel", unit: "points", aliases: ["hilton"] }),
  ihg: P({ key: "ihg", name: "IHG One Rewards", code: "IHG", kind: "hotel", unit: "points", aliases: ["ihg"] }),
  wyndham: P({ key: "wyndham", name: "Wyndham Rewards", code: "WY", kind: "hotel", unit: "points", aliases: ["wyndham"] }),
  radisson: P({ key: "radisson", name: "Radisson Rewards", code: "RD", kind: "hotel", unit: "points", aliases: ["radisson"] }),
  shangri_la: P({ key: "shangri_la", name: "Shangri-La Circle", code: "SL", kind: "hotel", unit: "points", aliases: ["shangri"] }),
  club_itc: P({ key: "club_itc", name: "Club ITC", code: "ITC", kind: "hotel", unit: "points", aliases: ["club itc", "itc hotels"] }),
  orchid: P({ key: "orchid", name: "Orchid Rewards", code: "OR", kind: "hotel", unit: "points", aliases: ["orchid rewards"] }),
  postcard: P({ key: "postcard", name: "Postcard Sunshine Club", code: "PC", kind: "hotel", unit: "points", aliases: ["postcard", "sunshine club"] }),
} satisfies Record<string, Program>;

export type ProgramKey = keyof typeof PROGRAMS;

/** Order and labels for grouping tiles and grid rows. */
export const PROGRAM_GROUPS: { key: Alliance | "hotel"; label: string }[] = [
  { key: "star", label: "Star Alliance" },
  { key: "oneworld", label: "oneworld" },
  { key: "skyteam", label: "SkyTeam" },
  { key: "none", label: "Other airlines" },
  { key: "hotel", label: "Hotels" },
];

export const groupOf = (p: Program): Alliance | "hotel" =>
  p.kind === "hotel" ? "hotel" : p.alliance ?? "none";

/** `from` units of the source become `to` units of the destination. */
export type Ratio = { from: number; to: number };

export type Bridge = {
  from: ProgramKey;
  to: ProgramKey;
  ratio: Ratio;
  /** Extra destination units granted per full block of source units. */
  bonus?: { per: number; extra: number };
  note: string;
};

// Avios: one currency shared by Qatar, BA, Iberia and Finnair, moved 1:1 in
// both directions (Qatar Privilege Club / point.me guides; Milelion, Jun 2026).
const AVIOS: ProgramKey[] = ["qatar_avios", "ba_avios", "iberia", "finnair"];
const AVIOS_NOTE = "Avios move 1:1 between these programs; names must match on both accounts";

// Marriott → airlines: 3:1, plus 5,000 bonus miles per 60,000 points — except
// American (no bonus) and United (10,000 bonus). AwardWallet's Marriott
// transfer table and Prince of Travel, checked 8 Nov 2026; no 2026 change found.
const MARRIOTT_BONUS = { per: 60000, extra: 5000 };
const MARRIOTT_NOTE = "Marriott converts 3:1, with 5,000 bonus miles for every 60,000 points";

export const BRIDGES: Bridge[] = [
  ...AVIOS.flatMap((a) =>
    AVIOS.filter((b) => b !== a).map((b): Bridge => ({
      from: a, to: b, ratio: { from: 1, to: 1 }, note: AVIOS_NOTE,
    }))),
  ...(["aeroplan", "krisflyer", "qatar_avios", "ba_avios", "flying_blue", "jal",
    "qantas", "asia_miles", "turkish", "etihad", "virgin"] as ProgramKey[]).map((to): Bridge => ({
    from: "marriott", to, ratio: { from: 3, to: 1 }, bonus: MARRIOTT_BONUS, note: MARRIOTT_NOTE,
  })),
  {
    from: "marriott", to: "united", ratio: { from: 3, to: 1 },
    bonus: { per: 60000, extra: 10000 },
    note: "Marriott converts 3:1, and United gives 10,000 bonus miles for every 60,000 points",
  },
  {
    from: "marriott", to: "aadvantage", ratio: { from: 3, to: 1 },
    note: "Marriott converts 3:1 to American, with no 60,000-point bonus",
  },
];
