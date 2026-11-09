// Curated "best routes": where card points are worth the most, and how to get
// there. Each route names only its TARGET program; the screen works out which
// of KP's cards reach it and how (direct, or via a real bridge from
// programs.ts), so a route never claims a path the data can't back.
//
// Award prices and seat availability move constantly, so these describe WHY a
// route is good and WHAT to watch, not a fixed points price.

import type { ProgramKey } from "./programs";

export type RouteTag = "Premium cabins" | "Cheap economy" | "Hotel nights" | "Bridge";

export type Route = {
  id: string;
  target: ProgramKey;
  title: string;
  /** What the miles get spent on. */
  book: string;
  tag: RouteTag;
  why: string;
  watch: string;
  source?: { label: string; url: string };
};

export const ROUTES: Route[] = [
  {
    id: "krisflyer-sq",
    target: "krisflyer",
    title: "Singapore Airlines business and Suites",
    book: "Singapore Airlines flights from India to Asia, Australia, Europe and the US",
    tag: "Premium cabins",
    why: "Singapore Airlines keeps most of its premium award seats for its own KrisFlyer members, so this is usually the only way to book them with points. Surcharges on its own flights are low.",
    watch: "KrisFlyer miles expire 3 years after they land. Check that seats are available before you transfer.",
  },
  {
    id: "qatar-qsuites",
    target: "qatar_avios",
    title: "Qatar Qsuites through Doha",
    book: "Qatar Airways business class to Europe, the US and Africa",
    tag: "Premium cabins",
    why: "Qatar Avios book Qatar's own business class with a short connection from Indian cities. The same Avios can also move 1:1 to British Airways, Iberia or Finnair if one of them prices the trip lower.",
    watch: "Taxes and carrier charges on Qatar awards are moderate, not zero. Avios bonus promotions come and go, so check for one before a big transfer.",
    source: { label: "point.me — Qatar Privilege Club guide", url: "https://www.point.me/insights/the-complete-guide-to-qatar-airways-privilege-club" },
  },
  {
    id: "avios-iberia",
    target: "iberia",
    title: "Avios hop: move to Iberia for Madrid flights",
    book: "Iberia's own flights through Madrid",
    tag: "Bridge",
    why: "Iberia often charges fewer Avios than British Airways for the same trip on its own planes. No Indian card reaches Iberia directly, but Avios from Qatar, BA or Finnair move across 1:1.",
    watch: "The name must match on both accounts, and some programs need the account to be a few weeks old before Avios can move. Compare the price in both programs before moving.",
  },
  {
    id: "aeroplan-star",
    target: "aeroplan",
    title: "Star Alliance to Europe and North America",
    book: "Swiss, Turkish, Air Canada, ANA and other Star Alliance airlines",
    tag: "Premium cabins",
    why: "Aeroplan prices partner flights on a fixed chart and generally doesn't add fuel surcharges. India sits in its Atlantic zone, which keeps India–Europe trips reasonably priced.",
    watch: "Since 1 June 2026 Lufthansa has released almost no cheap business seats to partner programs like Aeroplan. For Lufthansa itself, use Miles & More instead.",
    source: { label: "InsideFlyer — Lufthansa cuts partner business space", url: "https://www.insideflyer.com/posts/lufthansa-cuts-partner-business-class-award-space/" },
  },
  {
    id: "miles-and-more-lh",
    target: "miles_and_more",
    title: "Lufthansa seats through Miles & More",
    book: "Lufthansa, Swiss and Austrian flights",
    tag: "Premium cabins",
    why: "Lufthansa keeps more award seats for its own Miles & More members than it releases to partners. Axis added Miles & More as a direct partner in September 2026.",
    watch: "Miles & More adds high carrier surcharges, so the cash part of the ticket can be large. Axis also caps it at 2,00,000 miles a year, with a 3,000-mile minimum per transfer.",
    source: { label: "Magnify — Axis adds Miles & More", url: "https://magnify.club/guides/axis-accor-returns-miles-and-more-september-2026/" },
  },
  {
    id: "flying-blue-promo",
    target: "flying_blue",
    title: "Flying Blue monthly Promo Rewards",
    book: "Air France and KLM flights to Europe",
    tag: "Cheap economy",
    why: "Every month Flying Blue discounts awards on a list of routes, sometimes by a lot. It's one of the few programs every big Indian bank reaches at a good ratio.",
    watch: "Air France and KLM add carrier surcharges. Promos rotate monthly, so look at the current list before you transfer.",
  },
  {
    id: "turkish-star",
    target: "turkish",
    title: "Turkish Miles&Smiles for cheap Star Alliance",
    book: "Star Alliance partner flights, including short United flights in the US",
    tag: "Cheap economy",
    why: "Turkish's chart for partner flights has historically been one of the cheapest in Star Alliance.",
    watch: "Turkish has been raising prices, and many partner awards can only be booked by phone or at an office. Check how you'll book before you transfer.",
  },
  {
    id: "accor-fixed",
    target: "accor",
    title: "Accor: fixed-value hotel nights",
    book: "Any Accor hotel stay (Novotel, Pullman, Sofitel, Fairmont and more)",
    tag: "Hotel nights",
    why: "Every 2,000 Accor points take €40 off a stay, with no blackout dates. At a 1:1 transfer, each card point is worth about €0.02, which is usually better than the bank's own catalogue.",
    watch: "Only 1:1 transfers make sense here; 2:1 and 5:2 lose half or more of the value. Don't convert Accor points to airline miles: it's 2:1, and you lose half.",
    source: { label: "One Mile at a Time — Accor points value", url: "https://onemileatatime.com/guides/accor-live-limitless-points/" },
  },
  {
    id: "marriott-aa",
    target: "aadvantage",
    title: "Marriott as a bridge to American AAdvantage",
    book: "oneworld flights on American, Qatar, JAL and others, booked through AAdvantage",
    tag: "Bridge",
    why: "No Indian card reaches American AAdvantage directly. Marriott points convert to it 3:1, which can top up an award you've already found.",
    watch: "3:1 is a poor rate, and American gets no 60,000-point bonus. Only do this to top up a booking, never to stockpile miles.",
    source: { label: "AwardWallet — Marriott transfer partners", url: "https://awardwallet.com/mile-transfer-times?program=Marriott" },
  },
  {
    id: "air-india-star",
    target: "air_india",
    title: "Air India Maharaja Club for Star Alliance",
    book: "Air India flights, plus Star Alliance partners",
    tag: "Premium cabins",
    why: "Air India is in Star Alliance, so Maharaja Club points can book partner airlines as well as Air India. It's the only transfer partner for ICICI Emeralde Private Metal, at 1:1.",
    watch: "Booking partner awards can mean calling Air India, and transfers from some banks take several working days.",
    source: { label: "HappyFares — Maharaja Club for Star Alliance", url: "https://happyfares.in/blog/?p=4996" },
  },
];
