// Keyword-based default categorization for Indian merchants.
// User-defined mappings in merchant_mappings table take priority.
// Order matters — first match wins, so put more specific rules above broader
// ones. That is also how the two-tier split works (V2 feature A): a
// subcategory rule ("Dining · Coffee") sits ABOVE its parent's base rule, so
// "Starbucks" hits Coffee before the generic Dining net catches it.
//
// Rules without a subcategory leave it null — the txn renders as just the
// category. Every keyword lives in exactly ONE rule (ARCH-04).

const RULES: { category: string; subcategory?: string; keywords: string[] }[] = [
  {
    category: "Rent",
    keywords: ["red giraffe", "nobroker", "no broker", "magicbricks", "rent payment", "housingedge"],
  },
  {
    category: "Vouchers",
    keywords: ["gyftr", "gyfter", "smartbuy", "voucher", "wogo"],
  },
  {
    category: "Pets",
    keywords: ["heads up for tails", "huft", "supertails", "petsworld", "dogspot", "wiggles"],
  },
  {
    category: "Sports & Recreation",
    subcategory: "Pickleball",
    keywords: ["pickleball", "huddle"],
  },
  {
    category: "Sports & Recreation",
    subcategory: "Padel",
    keywords: ["padel"],
  },
  {
    category: "Sports & Recreation",
    keywords: ["playo", "kheloo", "khelomore", "sportskeeda"],
  },
  {
    category: "CRED Payments",
    keywords: ["cred ", "cred store", "cred ecom", "cred club", "cred cash"],
  },
  {
    // Quick commerce BEFORE the food-delivery rule: "Swiggy Instamart"
    // contains both "instamart" and "swiggy" and is groceries, not dining.
    category: "Groceries",
    subcategory: "Quick Commerce",
    keywords: ["blinkit", "zepto", "instamart", "grofers"],
  },
  {
    category: "Dining",
    subcategory: "Coffee",
    keywords: ["starbucks", "third wave", "blue tokai", "chaayos", "cafe", "coffee", "barista"],
  },
  {
    category: "Dining",
    subcategory: "Food Delivery",
    keywords: ["swiggy", "zomato", "eatsure", "foodpanda"],
  },
  {
    category: "Dining",
    subcategory: "Desserts",
    keywords: ["bakery", "patisserie", "theobroma"],
  },
  {
    category: "Dining",
    keywords: [
      "domino", "mcdonald", "kfc",
      "subway", "pizza", "burger", "bistro", "dhaba",
      "barbeque", "big chill", "social offline", "punjab grill", "wendy", "haldiram",
      "restaurant", "kitchen", "eatery", "diner",
    ],
  },
  {
    category: "Groceries",
    subcategory: "Supermarket",
    keywords: [
      "bigbasket", "dmart", "d-mart", "d mart",
      "nature's basket", "natures basket", "reliance smart", "reliance fresh",
      "spencer", "jiomart", "more supermarket", "star bazaar",
    ],
  },
  {
    category: "Groceries",
    keywords: ["freshmenu"],
  },
  {
    category: "Travel",
    subcategory: "Flights",
    keywords: [
      "indigo", "interglobe", "air india", "vistara", "spicejet", "akasa", "go first",
      "airlines", "airways",
    ],
  },
  {
    category: "Travel",
    subcategory: "Hotels",
    keywords: ["marriott", "taj hotels", "ihg", "hyatt", "hilton", "oyo", "airbnb"],
  },
  {
    category: "Travel",
    subcategory: "Lounges",
    keywords: ["lounge"],
  },
  {
    category: "Travel",
    keywords: ["makemytrip", "mmt", "goibibo", "yatra", "cleartrip", "airport", "travel edge", "wernost"],
  },
  {
    category: "Transport",
    subcategory: "Cabs",
    keywords: ["uber", "ola ", "rapido", "meru", "blablacar", "namma yatri"],
  },
  {
    category: "Transport",
    subcategory: "Metro & Rail",
    keywords: ["metro", "irctc"],
  },
  {
    category: "Transport",
    subcategory: "Bus",
    keywords: ["redbus"],
  },
  {
    category: "Transport",
    subcategory: "Auto",
    keywords: ["auto rickshaw"],
  },
  {
    category: "Transport",
    keywords: ["porter"],
  },
  {
    category: "Entertainment",
    subcategory: "Streaming",
    keywords: [
      "netflix", "hotstar", "disney", "amazon prime", "spotify", "gaana", "youtube",
      "zee5", "sonyliv", "jiocinema", "apple tv", "mxplayer",
    ],
  },
  {
    category: "Entertainment",
    subcategory: "Movies & Events",
    keywords: ["bookmyshow", "bms", "pvr", "inox"],
  },
  {
    category: "Fuel",
    keywords: [
      "petrol", "hpcl", "indian oil", "iocl", "bpcl", "bharat petroleum",
      "shell", "essar oil", "reliance petrol",
    ],
  },
  {
    // Pharmacy above Hospitals: "Apollo Pharmacy" contains both "apollo"
    // and "pharmacy" and must land in Pharmacy.
    category: "Healthcare",
    subcategory: "Pharmacy",
    keywords: ["medplus", "netmeds", "1mg", "tata 1mg", "pharmacy", "chemist"],
  },
  {
    category: "Healthcare",
    subcategory: "Diagnostics",
    keywords: ["thyrocare", "lal path", "metropolis"],
  },
  {
    category: "Healthcare",
    subcategory: "Hospitals & Clinics",
    keywords: ["apollo", "hospital", "clinic", "fortis", "max healthcare", "manipal hospital"],
  },
  {
    category: "Healthcare",
    keywords: ["practo", "medical"],
  },
  {
    category: "Shopping",
    subcategory: "Marketplace",
    keywords: ["amazon", "amzn", "flipkart", "meesho", "snapdeal", "tata cliq"],
  },
  {
    category: "Shopping",
    subcategory: "Fashion",
    keywords: [
      "myntra", "ajio", "h&m", "zara", "uniqlo", "westside",
      "lifestyle", "shoppers stop", "pantaloons", "max fashion",
    ],
  },
  {
    category: "Shopping",
    subcategory: "Beauty",
    keywords: ["nykaa"],
  },
  {
    category: "Shopping",
    subcategory: "Electronics",
    keywords: ["boat", "samsung", "apple", "croma", "reliance digital"],
  },
  {
    category: "Shopping",
    keywords: ["decathlon"],
  },
  {
    category: "Utilities",
    keywords: [
      "electricity", "bescom", "tata power", "adani electric",
      "airtel", "jio", "vi ", "vodafone", "bsnl", "tata sky",
      "dish tv", "d2h", "recharge", "fastag", "broadband",
    ],
  },
  {
    category: "Education",
    keywords: [
      "udemy", "coursera", "byju", "unacademy", "skill india",
      "whitehat", "vedantu", "upgrad", "scaler",
    ],
  },
  {
    category: "Financial",
    subcategory: "Insurance",
    keywords: ["insurance", "lic", "hdfc life", "icici pru", "sbi life"],
  },
  {
    category: "Financial",
    subcategory: "Investments",
    keywords: ["mutual fund", "groww", "zerodha", "kuvera"],
  },
  {
    category: "Financial",
    subcategory: "Jewellery",
    keywords: ["malabar gold", "jewellery", "jewelry", "gold"],
  },
  {
    category: "Financial",
    keywords: ["emi"],
  },
  {
    category: "Rewards",
    keywords: [
      "icici reward", "reward 360", "reward points",
    ],
  },
];

export type CategoryResult = { category: string; subcategory: string | null };

export function categorizeFull(merchant: string | null | undefined): CategoryResult {
  if (!merchant) return { category: "Uncategorized", subcategory: null };
  const lower = merchant.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      return { category: rule.category, subcategory: rule.subcategory ?? null };
    }
  }
  return { category: "Uncategorized", subcategory: null };
}

/** Category-only view — kept so existing callers/tests stay valid. */
export function categorize(merchant: string | null | undefined): string {
  return categorizeFull(merchant).category;
}
