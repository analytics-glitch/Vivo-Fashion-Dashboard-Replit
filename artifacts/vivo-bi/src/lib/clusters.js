// Store clusters — dashboard-level filter groups (leadership-defined).
// Keys are stable ids used in the URL (`cx=`); `stores` values must match
// all_sales.pos_location_name exactly.
// NOTE: "Sarit Outlet" trades in the data as "Zoya Sarit".
export const CLUSTERS = {
  cluster_a: {
    label: "Cluster A (Nairobi)",
    leader: "Emily Gor",
    stores: [
      "Vivo Junction",
      "Vivo Moi Avenue",
      "Vivo Yaya",
      "Vivo Galleria",
      "Vivo Capital Centre",
      "Vivo Hub",
      "Vivo Imaara",
      "Vivo Runda",
      "Vivo Kileleshwa",
    ],
  },
  cluster_b: {
    label: "Cluster B (Nairobi)",
    leader: "MaryAnn Kanumbi",
    stores: [
      "Vivo Sarit",
      "Vivo Mama Ngina St",
      "Vivo Garden City",
      "Vivo Village Market",
      "Vivo TRM",
      "Vivo Two Rivers",
      "Vivo Greenspan",
      "Vivo T- Mall",
      "Safari Sarit",
    ],
  },
  oot_outlet: {
    label: "Out of Town & Outlet",
    leader: null,
    stores: [
      "Vivo City Mall",
      "Vivo Nakuru",
      "Vivo Eldoret",
      "Vivo Kisumu",
      "Vivo Meru",
      "Vivo Signature Mall",
      "Zoya Sarit", // "Sarit Outlet"
      "Vivo MSA Digo Road",
    ],
  },
  out_of_country: {
    label: "Out of Country",
    leader: "Catherine Gicheru",
    stores: [
      "Vivo Kigali Heights",
      "The Oasis Mall",
      "Vivo Acacia",
    ],
  },
};

export const CLUSTER_IDS = Object.keys(CLUSTERS);

/** Union of store names for a list of cluster ids. */
export function clusterStores(ids) {
  const out = new Set();
  for (const id of ids || []) {
    for (const s of CLUSTERS[id]?.stores || []) out.add(s);
  }
  return Array.from(out);
}
