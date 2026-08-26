export const PRODUCTION_SCOPE_KEYS = [
  "stage", "factory_id", "line_id", "shift_id", "owner_user_id",
  "plan_status", "delivery_risk", "search",
];

export function readProductionScope(search = "") {
  const params = new URLSearchParams(search);
  return {
    date_from: params.get("date_from") || "",
    date_to: params.get("date_to") || "",
    ...Object.fromEntries(PRODUCTION_SCOPE_KEYS.map((key) => [
      key, params.get(`prod_${key}`) || "",
    ])),
  };
}

export function productionScopeParams(scope) {
  return Object.fromEntries(
    Object.entries(scope || {}).filter(([, value]) => value !== "" && value != null),
  );
}

export function hasProductionScope(scope) {
  return Object.values(scope || {}).some(Boolean);
}

export function ProductionScopeNotice({ scope, unsupported = [], applied = true, className = "" }) {
  if (!hasProductionScope(scope)) return null;
  const names = unsupported.map((key) => key.replace(/_/g, " ")).join(", ");
  return (
    <div data-testid="production-scope" data-scope-applied={applied ? "true" : "false"}
      className={`rounded-lg border px-3 py-2 text-xs ${applied ? "border-sky-200 bg-sky-50 text-sky-900" : "border-amber-300 bg-amber-50 text-amber-900"} ${className}`}>
      <strong>{applied ? "Command Centre scope applied." : "Command Centre scope is not applicable to this source."}</strong>
      {names && <span> Unsupported here: {names}.</span>}
    </div>
  );
}