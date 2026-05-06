// Normalize raw merchant strings from bank emails into clean, human-readable names.
//
// Examples:
//   "PYU*Swiggy"         → "Swiggy"
//   "AMAZON SELLER SERV" → "Amazon"
//   "RED GIRAFFE BLR"    → "Red Giraffe"
//   "BIG CHILL CAFE"     → "Big Chill"
//   "MAKEMYTRIP"         → "MakeMyTrip"

// Known merchants — exact match after preprocessing. User can override via merchant_mappings.
const KNOWN_MERCHANTS: { match: RegExp; name: string }[] = [
  { match: /^pyu\*?swiggy/i,           name: "Swiggy" },
  { match: /^swiggy/i,                 name: "Swiggy" },
  { match: /^zomato/i,                 name: "Zomato" },
  { match: /^amazon/i,                 name: "Amazon" },
  { match: /^amzn/i,                   name: "Amazon" },
  { match: /^flipkart/i,               name: "Flipkart" },
  { match: /^myntra/i,                 name: "Myntra" },
  { match: /^cred\s+(store|ecom|club|cash)?/i, name: "CRED" },
  { match: /^red\s+giraffe/i,          name: "Red Giraffe" },
  { match: /^nobroker/i,               name: "NoBroker" },
  { match: /^makemytrip|^mmt/i,        name: "MakeMyTrip" },
  { match: /^goibibo/i,                name: "Goibibo" },
  { match: /^heads\s+up\s+for\s+tails/i, name: "Heads Up For Tails" },
  { match: /^supertails/i,             name: "Supertails" },
  { match: /^big\s+chill/i,            name: "Big Chill" },
  { match: /^third\s+wave/i,           name: "Third Wave Coffee" },
  { match: /^blue\s+tokai/i,           name: "Blue Tokai" },
  { match: /^starbucks/i,              name: "Starbucks" },
  { match: /^huddle/i,                 name: "Huddle" },
  { match: /^playo/i,                  name: "Playo" },
  { match: /^decathlon/i,              name: "Decathlon" },
  { match: /^gyftr|gyfter/i,           name: "Gyftr" },
  { match: /^smartbuy|gyftr\s+smartbuy/i, name: "SmartBuy" },
  { match: /^eternal\s+limited/i,      name: "Zepto" },
  { match: /^gorally|raz\*gorally/i,   name: "GoRally" },
  { match: /^reward\s+360/i,           name: "ICICI Reward Points" },
  { match: /^malabar\s+gold/i,         name: "Malabar Gold" },
  { match: /^heistasse\s+bev|heistasse/i, name: "Third Wave Coffee" },
  { match: /^wernost/i,                name: "Travel Edge" },
  { match: /^uber/i,                   name: "Uber" },
  { match: /^ola\s+(cabs|electric)?/i, name: "Ola" },
  { match: /^rapido/i,                 name: "Rapido" },
  { match: /^bigbasket/i,              name: "BigBasket" },
  { match: /^blinkit/i,                name: "Blinkit" },
  { match: /^zepto/i,                  name: "Zepto" },
  { match: /^dmart|^d-mart/i,          name: "DMart" },
  { match: /^nature.?s\s+basket/i,     name: "Nature's Basket" },
  { match: /^netflix/i,                name: "Netflix" },
  { match: /^hotstar|^disney/i,        name: "Disney+ Hotstar" },
  { match: /^spotify/i,                name: "Spotify" },
  { match: /^bookmyshow|^bms/i,        name: "BookMyShow" },
  { match: /^pvr/i,                    name: "PVR" },
  { match: /^inox/i,                   name: "INOX" },
  { match: /^apollo/i,                 name: "Apollo" },
  { match: /^medplus/i,                name: "MedPlus" },
  { match: /^netmeds/i,                name: "Netmeds" },
  { match: /^1mg|tata\s+1mg/i,         name: "1mg" },
  { match: /^practo/i,                 name: "Practo" },
  { match: /^airtel/i,                 name: "Airtel" },
  { match: /^jio/i,                    name: "Jio" },
  { match: /^vi\s/i,                   name: "Vi" },
  { match: /^vodafone/i,               name: "Vodafone" },
  { match: /^indigo|interglobe/i,      name: "IndiGo" },
  { match: /^air\s*india/i,            name: "Air India" },
  { match: /^vistara/i,                name: "Vistara" },
  { match: /^spicejet/i,               name: "SpiceJet" },
  { match: /^marriott/i,               name: "Marriott" },
  { match: /^taj\s+(hotels|group)?/i,  name: "Taj Hotels" },
  { match: /^oyo/i,                    name: "OYO" },
  { match: /^airbnb/i,                 name: "Airbnb" },
];

// Strip leading payment processor prefixes
const PREFIX_RE = /^(pyu\*|bbps\*|ind\*|pos\s+|upi-?|paytm\*|payu\*|razp?\*|razorpay\*|raz\*|ccave\*|ccavenue\*)/i;

// Trim trailing location codes / 4-digit IDs / store numbers
const TRAILING_NOISE_RE = /\s+(?:[A-Z]{2,4}|[A-Z]{2,4}\s+IN|\d{2,6}|IND|MUMBAI|DELHI|BLR|BANGALORE|GURGAON|HYD|HYDERABAD|CHENNAI|NOIDA|PUNE)\s*$/i;

function titleCaseIfAllCaps(s: string): string {
  if (!/^[A-Z0-9\s&.,'\-]+$/.test(s)) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

export function cleanMerchant(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;

  // Stage 1: known merchants first (exact match handles all variations)
  for (const { match, name } of KNOWN_MERCHANTS) {
    if (match.test(s)) return name;
  }

  // Stage 2: generic cleanup
  s = s.replace(PREFIX_RE, "").trim();
  s = s.replace(TRAILING_NOISE_RE, "").trim();
  s = titleCaseIfAllCaps(s);

  return s || null;
}
