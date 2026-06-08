import { useGetKpiSummary } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUp, ArrowDown } from "lucide-react";
import { formatCompact, formatPercent, formatNumberCompact } from "@/lib/utils";

function KpiValue({ loading, value, title, change, isPositive, suffix = "" }: { loading: boolean, value: string, title: string, change: number, isPositive: boolean, suffix?: string }) {
  const accentColor = isPositive ? "#009118" : "#A60808";
  
  return (
    <Card className="shadow-sm border-muted/60 overflow-hidden relative">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary/20" />
      <CardContent className="p-5 pl-6">
        {loading ? (
          <>
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="h-8 w-32 mb-2" />
            <Skeleton className="h-3 w-20" />
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
            <div className="flex items-baseline gap-1 mt-1">
              <p className="text-3xl font-serif font-bold text-foreground">{value}</p>
              {suffix && <span className="text-sm font-medium text-muted-foreground">{suffix}</span>}
            </div>
            
            {change !== undefined && (
              <div className="flex items-center gap-1 mt-2" style={{ fontSize: "12px", color: "#6b7280" }}>
                {isPositive ? <ArrowUp className="w-3.5 h-3.5" style={{ color: accentColor }} /> : <ArrowDown className="w-3.5 h-3.5" style={{ color: accentColor }} />}
                <span style={{ color: accentColor, fontWeight: 500 }}>{Math.abs(change).toFixed(1)}%</span>
                <span>vs last year</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function KpiRow() {
  const { data, isLoading, isFetching } = useGetKpiSummary();
  const loading = isLoading || isFetching;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <KpiValue 
        loading={loading}
        title="Total Revenue"
        value={data ? formatCompact(data.totalRevenue) : ""}
        change={data?.revenueGrowthPct || 0}
        isPositive={(data?.revenueGrowthPct || 0) >= 0}
      />
      <KpiValue 
        loading={loading}
        title="Units Sold"
        value={data ? formatNumberCompact(data.unitsSold) : ""}
        change={data?.unitsGrowthPct || 0}
        isPositive={(data?.unitsGrowthPct || 0) >= 0}
      />
      <KpiValue 
        loading={loading}
        title="Gross Margin"
        value={data ? (data.grossMarginPct).toFixed(1) : ""}
        suffix="%"
        change={data?.marginChangePct || 0}
        isPositive={(data?.marginChangePct || 0) >= 0}
      />
      <KpiValue 
        loading={loading}
        title="Avg Order Value"
        value={data ? `$${(data.avgOrderValue).toFixed(0)}` : ""}
        change={data?.aovGrowthPct || 0}
        isPositive={(data?.aovGrowthPct || 0) >= 0}
      />
    </div>
  );
}
