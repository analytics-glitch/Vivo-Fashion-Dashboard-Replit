export type WorkspaceBiSource = {
  styles: Array<Record<string, any>>;
  orders: Array<Record<string, any>>;
  generatedAt?: string;
  [key: string]: any;
};

export const BI_SNAPSHOT_VERSION = 1;

type SnapshotClaimClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowCount: number | null }>;
};

export async function claimBiWorkspaceSnapshot(
  client: SnapshotClaimClient,
  schema: string,
  claimToken: string,
) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("Invalid snapshot schema");
  const claim = await client.query(
    `UPDATE ${schema}.bi_workspace_snapshot
       SET refresh_claimed_until=NOW()+INTERVAL '2 minutes',refresh_claim_token=$1
     WHERE singleton=TRUE
       AND (refresh_claimed_until IS NULL OR refresh_claimed_until<NOW())
     RETURNING singleton`,
    [claimToken],
  );
  return Boolean(claim.rowCount);
}

export function validateWorkspaceBiSource(value: unknown): WorkspaceBiSource {
  if (!value || typeof value !== "object") throw new Error("BI source is not an object");
  const source = value as WorkspaceBiSource;
  if (!Array.isArray(source.styles) || source.styles.length === 0) throw new Error("BI source has no styles");
  if (!Array.isArray(source.orders)) throw new Error("BI source has no orders");
  const usableStyles = source.styles.filter((style) =>
    String(style?.styleNumber ?? style?.style_number ?? style?.sku ?? "").trim() !== "");
  if (usableStyles.length < Math.max(1, Math.floor(source.styles.length * 0.9))) {
    throw new Error("BI source style identifiers are incomplete");
  }
  return source;
}

const normalise = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function buildOrderLookupIndex<T extends { styleNumber: unknown; styleName: unknown }>(orders: T[]) {
  const byNumber = new Map<string, T[]>();
  const byName = new Map<string, T[]>();
  for (const order of orders) {
    for (const [key, index] of [[normalise(order.styleNumber), byNumber], [normalise(order.styleName), byName]] as const) {
      if (!key) continue;
      const matches = index.get(key) ?? [];
      matches.push(order);
      index.set(key, matches);
    }
  }
  return {
    byNumber,
    byName,
    find(styleNumber: unknown, styleName: unknown) {
      const matched = new Set<T>();
      for (const order of byNumber.get(normalise(styleNumber)) ?? []) matched.add(order);
      for (const order of byName.get(normalise(styleName)) ?? []) matched.add(order);
      return [...matched];
    },
  };
}

export function buildFirstSequenceLookup<T>(rows: T[], styleNumber: (row: T) => unknown, styleName: (row: T) => unknown) {
  const byNumber = new Map<string, { row: T; position: number }>();
  const byName = new Map<string, { row: T; position: number }>();
  rows.forEach((row, position) => {
    const number = normalise(styleNumber(row));
    const name = normalise(styleName(row));
    if (number && !byNumber.has(number)) byNumber.set(number, { row, position });
    if (name && !byName.has(name)) byName.set(name, { row, position });
  });
  return {
    find(number: unknown, name: unknown) {
      const byNumberMatch = byNumber.get(normalise(number));
      const byNameMatch = byName.get(normalise(name));
      if (!byNumberMatch) return byNameMatch?.row ?? null;
      if (!byNameMatch) return byNumberMatch.row;
      return byNumberMatch.position <= byNameMatch.position ? byNumberMatch.row : byNameMatch.row;
    },
  };
}

export function buildOrderCountIndex(
  orders: Array<{ orderRef: string; styleNumber: string; styleName: string; quantity: number }>,
) {
  const byNumber = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const order of orders) {
    if (!(Number(order.quantity) > 0)) continue;
    const ref = String(order.orderRef);
    const number = normalise(order.styleNumber);
    const name = normalise(order.styleName);
    if (number) {
      const refs = byNumber.get(number) ?? new Set<string>();
      refs.add(ref);
      byNumber.set(number, refs);
    }
    if (name) {
      const refs = byName.get(name) ?? new Set<string>();
      refs.add(ref);
      byName.set(name, refs);
    }
  }
  return (styleNumber: unknown, styleName: unknown) => {
    const refs = new Set<string>();
    for (const ref of byNumber.get(normalise(styleNumber)) ?? []) refs.add(ref);
    for (const ref of byName.get(normalise(styleName)) ?? []) refs.add(ref);
    return refs.size;
  };
}

export function attachKnownGarmentImageUrls<T extends Record<string, any>>(
  rows: T[],
  availableKeys: Iterable<string>,
  source: "catalogue" | "plm",
  keyFor: (row: T) => unknown,
) {
  const available = new Set([...availableKeys].map(normalise));
  return rows.map((row) => {
    const key = normalise(keyFor(row));
    return key && available.has(key)
      ? { ...row, image: `/api/workspace/garment-images/${source}/${encodeURIComponent(key)}` }
      : row;
  });
}