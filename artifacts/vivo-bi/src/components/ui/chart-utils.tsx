export function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        backgroundColor: "#fff",
        borderRadius: "6px",
        padding: "10px 14px",
        border: "1px solid #e0e0e0",
        color: "#1a1a1a",
        fontSize: "13px",
      }}
      className="shadow-md"
    >
      <div style={{ marginBottom: "6px", fontWeight: 500, display: "flex", alignItems: "center", gap: "6px" }}>
        {payload.length === 1 && payload[0].color && payload[0].color !== "#ffffff" && (
          <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: payload[0].color, flexShrink: 0 }} />
        )}
        {label}
      </div>
      {payload.map((entry: any, index: number) => {
        let formattedValue = entry.value;
        if (typeof entry.value === "number") {
          // Attempt to infer formatting based on dataKey or name
          const key = (entry.name || entry.dataKey || "").toLowerCase();
          if (key.includes("pct") || key.includes("rate") || key.includes("margin") || key.includes("growth")) {
            formattedValue = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1 }).format(entry.value / 100);
          } else if (key.includes("revenue") || key.includes("value") || key.includes("sales") || key.includes("currentyear") || key.includes("prioryear")) {
            formattedValue = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(entry.value);
          } else {
            formattedValue = entry.value.toLocaleString();
          }
        }

        return (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" }}>
            {payload.length > 1 && entry.color && entry.color !== "#ffffff" && (
              <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: entry.color, flexShrink: 0 }} />
            )}
            <span style={{ color: "#444" }}>{entry.name || entry.dataKey}</span>
            <span style={{ marginLeft: "auto", fontWeight: 600 }}>
              {formattedValue}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CustomLegend({ payload }: any) {
  if (!payload || payload.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px 16px", fontSize: "13px", marginTop: "12px" }}>
      {payload.map((entry: any, index: number) => (
        <div key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: entry.color, flexShrink: 0 }} />
          <span>{entry.value}</span>
        </div>
      ))}
    </div>
  );
}
