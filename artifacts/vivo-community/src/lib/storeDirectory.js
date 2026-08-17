// ═════════════════════════════════════════════════════════════════════════
// Vivo store directory — powers the "Find a Store" page (Account → Help &
// Support). Store names follow the canonical POS list.
//
// All stores direct callers to the central customer-care line (contactInfo.js).
// Hours follow standard mall schedules; CBD branches use HOURS_CBD.
// Coordinates are accurate mall positions used for distance sorting and
// Google Maps directions.
// ═════════════════════════════════════════════════════════════════════════
import { CONTACT } from "./contactInfo";

const HOURS_MALL = "Mon–Sun · 9:00am–8:00pm";
const HOURS_CBD = "Mon–Sat · 8:30am–6:30pm";

const S = (country, name, mall, address, city, lat, lng, hours = HOURS_MALL) => ({
  country, name, mall, address, city, lat, lng, hours,
  phone: CONTACT.phoneDisplay,
  phoneHref: CONTACT.phoneHref,
});

export const STORE_DIRECTORY = [
  // ── Kenya ───────────────────────────────────────────────────────────
  S("Kenya", "Vivo Galleria", "Galleria Mall", "Lang'ata Road", "Nairobi", -1.3399, 36.7658),
  S("Kenya", "Vivo Junction", "The Junction Mall", "Ngong Road", "Nairobi", -1.2986, 36.7639),
  S("Kenya", "Vivo Sarit", "Sarit Centre", "Karuna Road, Westlands", "Nairobi", -1.2610, 36.8020),
  S("Kenya", "Vivo Yaya", "Yaya Centre", "Argwings Kodhek Road, Kilimani", "Nairobi", -1.2925, 36.7877),
  S("Kenya", "Vivo Village Market", "Village Market", "Limuru Road, Gigiri", "Nairobi", -1.2306, 36.8036),
  S("Kenya", "Vivo Two Rivers", "Two Rivers Mall", "Limuru Road, Ruaka", "Nairobi", -1.2100, 36.7940),
  S("Kenya", "Vivo Garden City", "Garden City Mall", "Thika Road", "Nairobi", -1.2320, 36.8790),
  S("Kenya", "Vivo TRM", "Thika Road Mall", "Thika Road, Roysambu", "Nairobi", -1.2195, 36.8886),
  S("Kenya", "Vivo Runda", "Runda Mall", "Northern Bypass, Runda", "Nairobi", -1.2210, 36.8300),
  S("Kenya", "Vivo Hub", "The Hub Karen", "Dagoretti Road, Karen", "Nairobi", -1.3190, 36.7080),
  S("Kenya", "Vivo T-Mall", "T-Mall", "Lang'ata Road, Nairobi West", "Nairobi", -1.3070, 36.8210),
  S("Kenya", "Vivo Capital Centre", "Capital Centre", "Mombasa Road", "Nairobi", -1.3140, 36.8340),
  S("Kenya", "Vivo Imaara", "Imaara Mall", "Mombasa Road", "Nairobi", -1.3230, 36.8700),
  S("Kenya", "Vivo Greenspan", "Greenspan Mall", "Donholm", "Nairobi", -1.2900, 36.8930),
  S("Kenya", "Vivo Kileleshwa", "Kileleshwa", "Oloitokitok Road, Kileleshwa", "Nairobi", -1.2780, 36.7830),
  S("Kenya", "Vivo Signature Mall", "Signature Mall", "Mombasa Road, Athi River", "Nairobi", -1.3960, 36.9480),
  S("Kenya", "Vivo Moi Avenue", "Moi Avenue", "Moi Avenue, CBD", "Nairobi", -1.2840, 36.8250, HOURS_CBD),
  S("Kenya", "Vivo Mama Ngina St", "Mama Ngina Street", "Mama Ngina Street, CBD", "Nairobi", -1.2860, 36.8230, HOURS_CBD),
  S("Kenya", "Vivo City Mall", "City Mall", "Links Road, Nyali", "Mombasa", -4.0210, 39.7080),
  S("Kenya", "Vivo MSA Digo Road", "Digo Road", "Digo Road, CBD", "Mombasa", -4.0570, 39.6640, HOURS_CBD),
  S("Kenya", "Vivo Nakuru", "Westside Mall", "Kenyatta Avenue", "Nakuru", -0.2840, 36.0640),
  S("Kenya", "Vivo Kisumu", "United Mall", "Jomo Kenyatta Highway", "Kisumu", -0.0980, 34.7660),
  S("Kenya", "Vivo Eldoret", "Rupa's Mall", "Malaba Road", "Eldoret", 0.5199, 35.2698),
  S("Kenya", "Vivo Meru", "Greenwood City Mall", "Meru–Nanyuki Road", "Meru", 0.0470, 37.6500),
  // ── Uganda ──────────────────────────────────────────────────────────
  S("Uganda", "Vivo Acacia", "Acacia Mall", "Cooper Road, Kololo", "Kampala", 0.3350, 32.5860),
  S("Uganda", "Vivo Oasis", "The Oasis Mall", "Yusuf Lule Road", "Kampala", 0.3140, 32.5870),
  // ── Rwanda ──────────────────────────────────────────────────────────
  S("Rwanda", "Vivo Kigali Heights", "Kigali Heights", "KG 7 Avenue, Kimihurura", "Kigali", -1.9530, 30.0920),
  S("Rwanda", "Vivo M-Peace Plaza", "M.Peace Plaza", "KN 4 Avenue, Nyarugenge", "Kigali", -1.9480, 30.0580),
];

export const STORE_COUNTRIES = ["Kenya", "Uganda", "Rwanda"];

export const directionsLink = (s) =>
  `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&destination_place_id=&travelmode=driving`;

export const mapEmbedSrc = (s) => {
  const d = 0.012;
  const bbox = [s.lng - d, s.lat - d, s.lng + d, s.lat + d].join("%2C");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${s.lat}%2C${s.lng}`;
};

// Haversine distance in km — used for "x km away" once she taps Use My Location.
export const distanceKm = (lat1, lng1, lat2, lng2) => {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
