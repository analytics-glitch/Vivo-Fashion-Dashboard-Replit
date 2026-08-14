// ═════════════════════════════════════════════════════════════════════════
// ⚠ PLACEHOLDER CONTACT DETAILS — Vivo must replace these with the real
//   customer-care WhatsApp line, phone number and email before launch.
//   Everything the Contact Us page shows comes from this one file.
// ═════════════════════════════════════════════════════════════════════════

export const CONTACT = {
  // PLACEHOLDER — real customer-care WhatsApp number goes here (digits only,
  // international format, no "+"). Used to build the wa.me deep link.
  whatsappNumber: "254700000000",
  whatsappPrefill: "Hi Vivo! I need a hand with something.",

  // PLACEHOLDER — real customer-care line.
  phoneDisplay: "+254 700 000 000",
  phoneHref: "tel:+254700000000",

  // PLACEHOLDER — real customer-care inbox.
  email: "care@vivofashiongroup.com",

  hours: "Mon–Sat · 9am–6pm EAT",
};

export const waLink = () =>
  `https://wa.me/${CONTACT.whatsappNumber}?text=${encodeURIComponent(CONTACT.whatsappPrefill)}`;

const maps = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

// Kenya locations are real Vivo stores; the Uganda and Rwanda entries are
// PLACEHOLDERS for Vivo to confirm/extend.
export const STORES = [
  { country: "Kenya", name: "Galleria Mall", area: "Lang'ata Road, Nairobi", maps: maps("Vivo Fashion Galleria Mall Nairobi") },
  { country: "Kenya", name: "The Junction Mall", area: "Ngong Road, Nairobi", maps: maps("Vivo Fashion The Junction Mall Nairobi") },
  { country: "Kenya", name: "Moi Avenue", area: "CBD, Nairobi", maps: maps("Vivo Fashion Moi Avenue Nairobi") },
  { country: "Uganda", name: "Acacia Mall", area: "Kololo, Kampala", maps: maps("Vivo Fashion Acacia Mall Kampala") }, // PLACEHOLDER
  { country: "Rwanda", name: "Kigali Heights", area: "KG 7 Avenue, Kigali", maps: maps("Vivo Fashion Kigali Heights Kigali") }, // PLACEHOLDER
];
