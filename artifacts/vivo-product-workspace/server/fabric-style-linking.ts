/**
 * Pure Level 3 naming and matching rules.  These deliberately do not know
 * about Postgres so the same certainty rules can be used by startup backfill,
 * reconciliation, and request validation.
 */
export type FabricStyleCandidate = {
  fabricStyleKey: string;
  fabricStyle: string;
  category?: string | null;
  subcategory?: string | null;
};

export function fabricStyleBase(name: unknown) {
  return String(name ?? "").split(/\s+-\s+/, 1)[0].trim();
}

export function normalizeFabricStyle(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactFabricStyle(value: unknown) {
  return normalizeFabricStyle(value).replace(/\s+/g, "");
}

function categorySuffix(candidate: FabricStyleCandidate, suffix: string) {
  const normalized = compactFabricStyle(suffix);
  return [candidate.category, candidate.subcategory]
    .map(compactFabricStyle)
    .some((value) => value !== "" && value === normalized);
}

/**
 * A duplicate spelling of the same Level 3 is one candidate, not ambiguity.
 * Prefix matching is intentionally constrained to a complete category or
 * subcategory suffix: "Linen Dress" must not auto-link "Linen".
 */
export function certainFabricStyleMatch(styleName: unknown, candidates: FabricStyleCandidate[]) {
  const needle = normalizeFabricStyle(styleName);
  const compactNeedle = compactFabricStyle(styleName);
  if (!needle) return { status: "unresolved" as const, candidates: [] as FabricStyleCandidate[] };
  const byKey = new Map<string, FabricStyleCandidate>();
  for (const candidate of candidates) {
    const key = compactFabricStyle(candidate.fabricStyle);
    if (key) byKey.set(`${normalizeFabricStyle(candidate.fabricStyleKey)}:${key}`, candidate);
  }
  const unique = [...byKey.values()];
  const exact = unique.filter((candidate) => compactFabricStyle(candidate.fabricStyle) === compactNeedle);
  if (exact.length === 1) return { status: "resolved" as const, fabricStyleKey: exact[0].fabricStyleKey, candidates: exact };
  const prefix = unique.filter((candidate) => {
    const base = compactFabricStyle(candidate.fabricStyle);
    return compactNeedle.startsWith(base) && categorySuffix(candidate, compactNeedle.slice(base.length));
  });
  if (prefix.length === 1) return { status: "resolved" as const, fabricStyleKey: prefix[0].fabricStyleKey, candidates: prefix };
  const possible = unique.filter((candidate) => compactNeedle === compactFabricStyle(candidate.fabricStyle)
    || compactNeedle.startsWith(compactFabricStyle(candidate.fabricStyle)));
  return { status: possible.length > 1 ? "ambiguous" as const : "unresolved" as const, candidates: possible };
}