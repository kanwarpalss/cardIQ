// Keyword-based default categorization for Indian merchants.
// User-defined mappings in merchant_mappings table take priority.
// Order matters — first match wins, so put more specific rules above broader ones.

const RULES: { category: string; keywords: string[] }[] = [
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
    keywords: ["huddle", "playo", "kheloo", "padel", "pickleball", "khelomore", "sportskeeda"],
  },
  {
    category: "CRED Payments",
    keywords: ["cred ", "cred store", "cred ecom", "cred club", "cred cash"],
  },
  {
    category: "Dining",
    keywords: [
      "swiggy", "zomato", "eatsure", "foodpanda", "domino", "mcdonald", "kfc",
      "subway", "pizza", "burger", "cafe", "coffee", "bistro", "dhaba",
      "chaayos", "starbucks", "third wave", "blue tokai", "barbeque",
      "big chill", "social offline", "punjab grill", "wendy", "haldiram",
      "restaurant", "kitchen", "eatery", "diner", "bakery", "patisserie",
    ],
  },
  {
    category: "Groceries",
    keywords: [
      "bigbasket", "blinkit", "zepto", "instamart", "dmart", "d-mart", "d mart",
      "nature's basket", "natures basket", "reliance smart", "reliance fresh",
      "spencer", "grofers", "jiomart", "more supermarket", "star bazaar", "freshmenu",
    ],
  },
  {
    category: "Travel",
    keywords: [
      "makemytrip", "mmt", "goibibo", "yatra", "cleartrip", "airbnb", "oyo",
      "indigo", "interglobe", "air india", "vistara", "spicejet", "akasa", "go first",
      "marriott", "taj hotels", "ihg", "hyatt", "hilton", "airport", "lounge",
      "airlines", "airways", "travel edge", "wernost",
    ],
  },
  {
    category: "Transport",
    keywords: [
      "uber", "ola ", "rapido", "metro", "irctc", "redbus", "meru",
      "blablacar", "porter", "namma yatri", "auto rickshaw",
    ],
  },
  {
    category: "Entertainment",
    keywords: [
      "netflix", "hotstar", "disney", "amazon prime", "spotify", "gaana", "youtube",
      "bookmyshow", "bms", "pvr", "inox", "zee5", "sonyliv", "jiocinema",
      "apple tv", "mxplayer",
    ],
  },
  {
    category: "Fuel",
    keywords: [
      "petrol", "hpcl", "indian oil", "iocl", "bpcl", "bharat petroleum",
      "shell", "essar oil", "reliance petrol",
    ],
  },
  {
    category: "Healthcare",
    keywords: [
      "apollo", "medplus", "netmeds", "1mg", "tata 1mg", "practo", "thyrocare",
      "lal path", "metropolis", "hospital", "clinic", "pharmacy",
      "chemist", "medical", "fortis", "max healthcare", "manipal hospital",
    ],
  },
  {
    category: "Shopping",
    keywords: [
      "amazon", "amzn", "flipkart", "myntra", "ajio", "nykaa", "meesho",
      "snapdeal", "tata cliq", "h&m", "zara", "uniqlo", "westside",
      "lifestyle", "shoppers stop", "pantaloons", "max fashion",
      "boat", "samsung", "apple", "croma", "reliance digital", "decathlon",
    ],
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
    keywords: [
      "insurance", "lic", "hdfc life", "icici pru", "sbi life",
      "mutual fund", "groww", "zerodha", "kuvera", "emi",
      "malabar gold", "jewellery", "jewelry", "gold",
    ],
  },
  {
    category: "Rewards",
    keywords: [
      "icici reward", "reward 360", "reward points",
    ],
  },
];

export function categorize(merchant: string | null | undefined): string {
  if (!merchant) return "Uncategorized";
  const lower = merchant.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) return rule.category;
  }
  return "Uncategorized";
}
