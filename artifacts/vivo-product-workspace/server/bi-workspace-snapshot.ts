export type WorkspaceBiSource = {
  styles: Array<Record<string, any>>;
  orders: Array<Record<string, any>>;
  generatedAt?: string;
  [key: string]: any;
};

export const BI_SNAPSHOT_VERSION = 1;

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