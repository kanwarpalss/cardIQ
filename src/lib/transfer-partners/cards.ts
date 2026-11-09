// Which loyalty programs each card's points transfer to, and at what ratio.
//
// Every list here comes from public guides, NOT from the banks: none of the
// four banks publishes a readable, current partner table (Axis's PDF is known
// stale; HDFC's lives behind the SmartBuy login; HSBC's is in-app). So:
//   - each spec names its sources and the date they were checked;
//   - where sources disagree on a ratio, the LESS generous one is encoded and
//     `disputed` says what the other source claims — overstating a ratio
//     invites a transfer that turns out worse than promised, and transfers
//     can't be reversed;
//   - per KP's rule (cardholder statements outrank blogs), anything KP reads
//     in his bank app overrides these and should replace them with attribution.
// Re-check and bump `checked_on` whenever a bank announces a change.

import type { ProgramKey, Ratio } from "./programs";

export type CardTransfer = {
  program: ProgramKey;
  ratio: Ratio;
  /** Bank-side grouping that shares a yearly cap (Axis Group A/B). */
  group?: string;
  /** Typical time for the miles to land. */
  time?: string;
  /** Set when sources disagree; says what the other claim is. */
  disputed?: string;
  note?: string;
};

/** `date` is the page's own published/updated date; omitted when it shows none. */
export type Source = { label: string; url: string; date?: string };

export type TransferSpec = {
  product_key: string;
  partners: CardTransfer[];
  /** Smallest transfer the bank accepts, in card points. */
  min?: number;
  /** Transfers must be a multiple of this many card points. */
  increment?: number;
  /** Plain-English caps, fees and timing — shown as-is. */
  rules: string[];
  /** Spec-wide doubt worth showing above the partner list. */
  caveat?: string;
  /** Why a card has no partners (cashback cards). */
  none_reason?: string;
  sources: Source[];
  checked_on: string;
};

const r = (from: number, to: number): Ratio => ({ from, to });

// ── Axis Magnus for Burgundy ────────────────────────────────────────────────
// CardExpress (23 Sep 2026, read from the Travel EDGE portal), PointsMath
// (24 Sep 2026), Magnify (Apr–Sep 2026). 2 Apr 2026 removed Marriott, Accor
// and Qatar; Qatar came back in July and Accor in September, both at 5:2.
// Marriott and ITC have NOT returned.
const AXIS_GROUP_DISPUTE =
  "CardExpress and Magnify put this in Group A (moved from B in Sep 2026); PointsMath still shows Group B. The ratio is the same either way";
const AXIS_A = "Group A";
const AXIS_B = "Group B";

const AXIS_MAGNUS_BURGUNDY: TransferSpec = {
  product_key: "axis_magnus_burgundy",
  partners: [
    { program: "krisflyer", ratio: r(5, 4), group: AXIS_A },
    { program: "aeroplan", ratio: r(5, 4), group: AXIS_A },
    { program: "united", ratio: r(5, 4), group: AXIS_A },
    { program: "turkish", ratio: r(5, 4), group: AXIS_A },
    { program: "thai", ratio: r(5, 4), group: AXIS_A },
    { program: "ethiopian", ratio: r(5, 4), group: AXIS_A },
    { program: "air_india", ratio: r(5, 4), group: AXIS_A, disputed: AXIS_GROUP_DISPUTE },
    { program: "miles_and_more", ratio: r(5, 4), group: AXIS_B,
      note: "Added Sep 2026. Own cap: 2,00,000 Miles & More miles a year, minimum 3,000 miles per transfer" },
    { program: "jal", ratio: r(5, 4), group: AXIS_A },
    { program: "qantas", ratio: r(5, 4), group: AXIS_A, disputed: AXIS_GROUP_DISPUTE },
    { program: "flying_blue", ratio: r(5, 4), group: AXIS_A, disputed: AXIS_GROUP_DISPUTE },
    { program: "etihad", ratio: r(5, 4), group: AXIS_A },
    { program: "qatar_avios", ratio: r(5, 2), group: AXIS_A,
      note: "Returned Jul 2026 at the lower ratio",
      disputed: "Only PointsMath states the 5:2 figure; other guides confirm the return but not the ratio" },
    { program: "ba_avios", ratio: r(5, 2), group: AXIS_A, note: "Added Apr 2026" },
    { program: "finnair", ratio: r(5, 2), group: AXIS_A, note: "Added Apr 2026" },
    { program: "asia_miles", ratio: r(5, 2), group: AXIS_A, note: "Added Sep 2026" },
    { program: "lotusmiles", ratio: r(5, 2), group: AXIS_A, note: "Added Apr 2026" },
    { program: "airasia", ratio: r(5, 4), group: AXIS_B },
    { program: "spicejet", ratio: r(5, 4), group: AXIS_B },
    { program: "indigo", ratio: r(5, 2), group: AXIS_B,
      note: "Axis has run a better introductory rate it can withdraw; 5:2 is the standard rate" },
    { program: "accor", ratio: r(5, 2), group: AXIS_A, note: "Returned Sep 2026 at the lower ratio" },
    { program: "wyndham", ratio: r(5, 4), group: AXIS_A },
    { program: "hilton", ratio: r(5, 4), group: AXIS_B, note: "Added Sep 2026" },
    { program: "ihg", ratio: r(5, 4), group: AXIS_B },
    { program: "radisson", ratio: r(5, 4), group: AXIS_B },
    { program: "orchid", ratio: r(5, 4), group: AXIS_B },
    { program: "postcard", ratio: r(5, 4), group: AXIS_B },
  ],
  rules: [
    "Yearly caps per customer: 2,00,000 EDGE points to Group A, 8,00,000 to Group B (resets 1 January)",
    "Two Magnus Burgundy cards share one cap, because it counts per customer, not per card",
    "₹199 + GST per transfer (PointsMath)",
    "Usually 2–3 days; some partners take up to 10",
    "Marriott and ITC are no longer partners",
  ],
  sources: [
    { label: "CardExpress — Axis Group A & B", url: "https://cardexpress.in/articles/axis-edge-transfer-partners-group-a-group-b", date: "2026-09-23" },
    { label: "PointsMath — Axis transfer partners", url: "https://pointsmath.com/axis-bank-transfer-partners/", date: "2026-09-24" },
    { label: "Magnify — Accor returns, Miles & More added", url: "https://magnify.club/guides/axis-accor-returns-miles-and-more-september-2026/", date: "2026-09-23" },
  ],
  checked_on: "2026-11-08",
};

// ── HSBC TravelOne and HSBC Premier (identical lists) ───────────────────────
// Magnify (Apr 2026), PointsMath (Oct 2025), points.casa (checked 30 Sep
// 2026) and Card Maven (7 Nov 2026). The first three agree; Card Maven alone
// says Turkish, United, Hainan and EVA are 1:1 and adds Aeroplan. points.casa
// says outright that HSBC does NOT reach Aeroplan, so Aeroplan is left out.
// No source reports Accor or Marriott leaving HSBC.
const HSBC_PARTNERS: CardTransfer[] = [
  { program: "krisflyer", ratio: r(1, 1), time: "Within a day" },
  { program: "air_india", ratio: r(1, 1), time: "Up to 5 working days" },
  { program: "thai", ratio: r(1, 1), time: "Within a day" },
  { program: "turkish", ratio: r(2, 1), time: "Within a day",
    disputed: "Card Maven (Nov 2026) says 1:1; Magnify and PointsMath say 2:1" },
  { program: "united", ratio: r(2, 1), time: "Within a day",
    disputed: "Card Maven (Nov 2026) says 1:1; Magnify and PointsMath say 2:1" },
  { program: "eva", ratio: r(2, 1), time: "Within a day",
    disputed: "Magnify and Card Maven say 1:1; PointsMath says 2:1" },
  { program: "qatar_avios", ratio: r(1, 1), time: "Within a day" },
  { program: "ba_avios", ratio: r(1, 1), time: "Within a day" },
  { program: "jal", ratio: r(1, 1), time: "Up to 10 working days" },
  { program: "qantas", ratio: r(1, 1), time: "Within a day" },
  { program: "flying_blue", ratio: r(1, 1), time: "Within a day" },
  { program: "lotusmiles", ratio: r(1, 1), time: "Within a day" },
  { program: "etihad", ratio: r(1, 1), time: "Within a day" },
  { program: "airasia", ratio: r(1, 3), time: "Within a day" },
  { program: "hainan", ratio: r(2, 1), time: "Up to 5 working days",
    disputed: "Card Maven (Nov 2026) says 1:1; Magnify and PointsMath say 2:1" },
  { program: "accor", ratio: r(1, 1), time: "Within a day" },
  { program: "marriott", ratio: r(1, 1), time: "Within a day" },
  { program: "ihg", ratio: r(1, 1), time: "Within a day" },
  { program: "wyndham", ratio: r(1, 1), time: "Within a day" },
  { program: "shangri_la", ratio: r(5, 1), time: "Within a day" },
];

const HSBC_RULES = [
  "No minimum and no fee (HSBC India's redemption guide, via points.casa)",
  "No yearly transfer cap reported",
  "Most partners credit within a day; Air India up to 5 working days, JAL up to 10",
];

const HSBC_SOURCES: Source[] = [
  { label: "Card Maven — TravelOne review", url: "https://cardmaven.in/hsbc-travelone-credit-card-review/", date: "2026-11-07" },
  { label: "points.casa — HSBC transfers", url: "https://points.casa/tools/transfers/hsbc/", date: "2026-09-30" },
  { label: "Magnify — HSBC Premier review", url: "https://magnify.club/guides/hsbc-premier-credit-card-review/", date: "2026-04-07" },
  { label: "PointsMath — HSBC partners", url: "https://pointsmath.com/hsbc-points-transfer-partners-india/", date: "2025-10-05" },
];

const HSBC_TRAVELONE: TransferSpec = {
  product_key: "hsbc_travelone",
  partners: HSBC_PARTNERS, rules: HSBC_RULES, sources: HSBC_SOURCES, checked_on: "2026-11-08",
};
const HSBC_PREMIER: TransferSpec = {
  product_key: "hsbc_premier",
  partners: HSBC_PARTNERS, rules: HSBC_RULES, sources: HSBC_SOURCES, checked_on: "2026-11-08",
};

// ── HDFC Infinia ────────────────────────────────────────────────────────────
// CardAdvisor (updated 2 Nov 2026), Flightpoints (9 Oct 2026) and MilesAhead
// (Mar 2026) agree on every ratio they list. Transfers run through SmartBuy.
const HDFC_INFINIA: TransferSpec = {
  product_key: "hdfc_infinia",
  partners: [
    { program: "krisflyer", ratio: r(1, 1), time: "Up to about 7 working days" },
    { program: "aeroplan", ratio: r(2, 1) },
    { program: "united", ratio: r(2, 1) },
    { program: "turkish", ratio: r(2, 1) },
    { program: "thai", ratio: r(2, 1) },
    { program: "air_india", ratio: r(2, 1), time: "2–4 working days" },
    { program: "lifemiles", ratio: r(2, 1) },
    { program: "qatar_avios", ratio: r(2, 1) },
    { program: "ba_avios", ratio: r(2, 1) },
    { program: "finnair", ratio: r(1, 1) },
    { program: "asia_miles", ratio: r(2, 1) },
    { program: "flying_blue", ratio: r(1, 1) },
    { program: "lotusmiles", ratio: r(1, 1) },
    { program: "etihad", ratio: r(2, 1) },
    { program: "airasia", ratio: r(1, 1) },
    { program: "spicejet", ratio: r(1, 1) },
    { program: "accor", ratio: r(2, 1), time: "1–5 days" },
    { program: "marriott", ratio: r(2, 1), time: "1–5 days" },
    { program: "club_itc", ratio: r(2, 1), note: "Moves in blocks of 200 points" },
    { program: "ihg", ratio: r(1, 1) },
    { program: "radisson", ratio: r(1, 1) },
    { program: "wyndham", ratio: r(1, 1) },
  ],
  min: 1000,
  increment: 1000,
  rules: [
    "Up to 1,50,000 points a month, done through SmartBuy",
    "Minimum 1,000 points, in multiples of 1,000",
    "No transfer fee reported; transfers can't be reversed",
    "Finnair is an Avios program: 1:1 Finnair Avios can move on to Qatar or BA",
  ],
  sources: [
    { label: "CardAdvisor — HDFC transfer guide", url: "https://cardadvisor.in/articles/hdfc-reward-points-transfer-guide", date: "2026-11-02" },
    { label: "Flightpoints — Infinia partners", url: "https://flightpoints.com/blogs/hdfc-infinia-transfer-partners-ratios-guide/", date: "2026-10-09" },
  ],
  checked_on: "2026-11-08",
};

// ── ICICI Emeralde Private Metal ────────────────────────────────────────────
// Only Air India, 1:1 (points.casa; CardMaven; CardAdvisor — all agree, but
// none of the pages shows a date, and one search result was ~18 months old).
const ICICI_EPM: TransferSpec = {
  product_key: "icici_emeralde_private_metal",
  partners: [{ program: "air_india", ratio: r(1, 1) }],
  min: 1000,
  rules: [
    "Air India is the only partner",
    "Minimum 1,000 points",
  ],
  sources: [
    { label: "points.casa — ICICI transfers", url: "https://points.casa/tools/transfers/icici/" },
    { label: "CardMaven — Emeralde Private Metal review", url: "https://cardmaven.in/icici-bank-emeralde-private-metal-credit-card-review/" },
  ],
  checked_on: "2026-11-08",
};

// ── Amex Platinum Travel ────────────────────────────────────────────────────
// Amex India Membership Rewards list: Magnify (18 Aug 2026), CardAdvisor
// (25 Sep 2026), Live From A Lounge (Aug 2026). Etihad left on 1 Jul 2026.
// No source states ratios for Platinum Travel specifically.
const AMEX_PLATINUM_TRAVEL: TransferSpec = {
  product_key: "amex_platinum_travel",
  partners: [
    { program: "krisflyer", ratio: r(2, 1) },
    { program: "qatar_avios", ratio: r(2, 1) },
    { program: "ba_avios", ratio: r(2, 1) },
    { program: "asia_miles", ratio: r(2, 1) },
    { program: "virgin", ratio: r(5, 4), note: "Improved from 2:1 in Aug 2026; Amex gave no end date" },
    { program: "marriott", ratio: r(1, 1), time: "Up to 48 hours" },
    { program: "hilton", ratio: r(2, 3), note: "Improved from 1:0.9 in Aug 2026" },
  ],
  min: 1000,
  rules: [
    "Minimum 1,000 points",
    "Etihad stopped being a partner on 1 July 2026",
  ],
  caveat: "These are Amex India's Membership Rewards ratios; no source confirms them for Platinum Travel specifically.",
  sources: [
    { label: "CardAdvisor — Amex MR guide", url: "https://cardadvisor.in/articles/amex-membership-rewards-guide-2026", date: "2026-09-25" },
    { label: "Magnify — Amex India partners", url: "https://magnify.club/guides/amex-india-transfer-partners/", date: "2026-08-18" },
  ],
  checked_on: "2026-11-08",
};

const HDFC_SWIGGY: TransferSpec = {
  product_key: "hdfc_swiggy",
  partners: [],
  none_reason: "Cashback card: rewards come back as money off your bill, so there's nothing to transfer.",
  rules: [],
  sources: [],
  checked_on: "2026-11-08",
};

export const TRANSFER_SPECS: Record<string, TransferSpec> = Object.fromEntries(
  [AXIS_MAGNUS_BURGUNDY, HSBC_TRAVELONE, HSBC_PREMIER, HDFC_INFINIA, ICICI_EPM,
    AMEX_PLATINUM_TRAVEL, HDFC_SWIGGY].map((s) => [s.product_key, s])
);
