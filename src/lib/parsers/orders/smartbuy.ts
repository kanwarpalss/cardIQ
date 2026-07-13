// HDFC SmartBuy travel parser — flights & hotels (V2 feature C).
//
// SmartBuy (donotreply@smartbuyoffers.co) books travel through partners
// (Cleartrip, MakeMyTrip) and emails a full itinerary. KP wants the WHO / WHEN /
// WHERE surfaced, so we build a readable itinerary line as the item.
//
// Verified against KP's real emails:
//  FLIGHT "Your Flight Booking with SmartBuy is Successful …":
//    "smartbuy Flight --> … Amount Paid Rs 6,915 … Contact Number 9650077811
//     IndiGo 6E - 6634 IXC BLR Class E … Airline PNR V3YIXX
//     2023-OCT-19 08:10 IXC Chandigarh Terminal :- 3 h 05 min --Via-- Non-Stop
//     2023-OCT-19 11:15 BLR Bangalore Terminal :- 1
//     Passengers Adult 1: Mr. Amarjit Anand … Paid by card Rs 6,915"
//  HOTEL "Your Hotel Booking with SmartBuy is Successful …":
//    "smartbuy Hotel --> … Contact Number 9650077811 Goa Marriott Resort & Spa
//     Miramar Beach, … 2023-09-29 2023-10-01 … Room Type : Guest room, 1 King,
//     Garden view … Adult 1: Kanwar … Paid by card Rs 48,945"
//
// total_amount is "Paid by card Rs X" — the card portion (points/vouchers cover
// the rest), which is what matches the bank charge — NOT the full "Amount Paid".

import { type ParsedOrder, type OrderItem, parseInrAmount } from "./types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Paid by card Rs X" (the card portion) → else "Amount Paid Rs X". */
function cardAmount(text: string): number | undefined {
  const card = /Paid by card\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  const any = /Amount Paid\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  const raw = card?.[1] ?? any?.[1];
  return raw ? parseInrAmount(raw) : undefined;
}

const ORDER_ID_RE = /Order ID\s+(\d{6,})/i;

/** "2023-OCT-19" or "2023-09-29" → "19 Oct 2023". */
function prettyDate(raw: string): string {
  const m = /(\d{4})-([A-Za-z]{3}|\d{2})-(\d{2})/.exec(raw);
  if (!m) return raw;
  const mon = /\d/.test(m[2]) ? MONTHS[parseInt(m[2], 10) - 1] : m[2].toLowerCase();
  const label = mon ? mon[0].toUpperCase() + mon.slice(1) : m[2];
  return `${parseInt(m[3], 10)} ${label} ${m[1]}`;
}

function parseFlight(text: string): ParsedOrder | null {
  const total = cardAmount(text);
  // Legs: "<date> <time> <CODE> <City>" — first is departure, last is arrival.
  const legs = [...text.matchAll(/(\d{4}-[A-Za-z]{3}-\d{2})\s+(\d{2}:\d{2})\s+([A-Z]{3})\s+([A-Z][a-zA-Z]+)/g)];
  const airline = /([A-Za-z][A-Za-z ]*?\s+[0-9A-Z]{2}\s*-\s*\d{2,5})\s+[A-Z]{3}\s+[A-Z]{3}\s+Class/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim();
  const pnr = /Airline PNR\s+([A-Z0-9]{5,7})/i.exec(text)?.[1];
  const passenger = /Adult 1:\s*(.+?)\s+(?:Payments|Fare Summary|Basefare|Child)/i.exec(text)?.[1]?.trim();

  const parts: string[] = [];
  if (legs.length >= 2) {
    const dep = legs[0], arr = legs[legs.length - 1];
    parts.push(`Flight: ${dep[4]} (${dep[3]}) → ${arr[4]} (${arr[3]})`);
    parts.push(prettyDate(dep[1]));
  } else {
    parts.push("Flight");
  }
  if (airline) parts.push(airline);
  if (passenger) parts.push(passenger);
  if (pnr) parts.push(`PNR ${pnr}`);

  return {
    source: "smartbuy",
    kind: "order",
    order_ref: ORDER_ID_RE.exec(text)?.[1],
    merchant_name: "SmartBuy Flight",
    total_amount: total,
    items: [{ name: parts.join(" · ") }],
  };
}

function parseHotel(text: string): ParsedOrder | null {
  const total = cardAmount(text);
  // "Contact Number <n> <Hotel + address> <checkin YYYY-MM-DD> <checkout YYYY-MM-DD>"
  const block = /Contact Number\s+\d+\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
  const hotel = block?.[1]?.split(",")[0]?.trim(); // name is before the address comma
  const checkIn = block?.[2], checkOut = block?.[3];
  const room = /Room Type\s*:\s*(.+?)\s+(?:No of Guests|Inclusion|Adult|Date)/i.exec(text)?.[1]?.trim();
  const guest = /Adult 1:\s*(.+?)\s+(?:Fare|Payments)/i.exec(text)?.[1]?.trim();

  const parts: string[] = [];
  parts.push(`Hotel: ${hotel ?? "(unknown)"}`);
  if (checkIn && checkOut) parts.push(`${prettyDate(checkIn)}–${prettyDate(checkOut)}`);
  if (room) parts.push(room);
  if (guest) parts.push(guest);

  return {
    source: "smartbuy",
    kind: "order",
    order_ref: ORDER_ID_RE.exec(text)?.[1],
    merchant_name: "SmartBuy Hotel",
    total_amount: total,
    items: [{ name: parts.join(" · ") } as OrderItem],
  };
}

export function parseSmartbuyOrder(subject: string, text: string, _html: string): ParsedOrder | null {
  if (!/Booking with SmartBuy/i.test(subject) && !/smartbuy\s+(Flight|Hotel)/i.test(text)) return null;
  if (/\bFlight\b/i.test(text.slice(0, 40)) || /Flight Booking/i.test(subject)) return parseFlight(text);
  if (/\bHotel\b/i.test(text.slice(0, 40)) || /Hotel Booking/i.test(subject)) return parseHotel(text);
  return null;
}
