import { useGetSalesByCategory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import { CustomTooltip } from "@/components/ui/chart-utils";
import { CHART_COLORS } from "@/lib/utils";

export function CategorySalesChart({ isDark }: { isDark: boolean }) {
  const { data, isLoading, isFetching } = useGetSalesByCategory();
  const loading = isLoading || isFetching;
  
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "#e5e5e5";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const sortedData = data ? [...data].sort((a, b) => b.revenue - a.revenue) : [];

  return (
    <Card className="shadow-sm border-muted/60">
      <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-serif">Category Performance</CardTitle>
        {!loading && sortedData.length > 0 && (
          <CSVLink 
            data={sortedData} 
            filename="category-sales.csv" 
            className="print:hidden flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors hover:opacity-80 border" 
            style={{ 
              backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#ffffff", 
              color: isDark ? "#c8c9cc" : "#4b5563",
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "#e5e7eb"
            }} 
            aria-label="Export chart data as CSV"
          >
            <Download className="w-3.5 h-3.5" />
          </CSVLink>
        )}
      </CardHeader>
      <CardContent className="p-5 pt-0">
        {loading ? (
          <Skeleton className="w-full h-[280px]" />
        ) : sortedData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280} debounce={0}>
            <BarChart data={sortedData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="category" tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} axisLine={false} tickLine={false} dy={10} />
              <YAxis tickFormatter={(value) => `$${(value / 1000000).toFixed(1)}M`} tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} axisLine={false} tickLine={false} dx={-10} />
              <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={false} />
              <Bar dataKey="revenue" name="Revenue" fill={CHART_COLORS.blue} fillOpacity={0.9} activeBar={{ fillOpacity: 1 }} isAnimationActive={false} radius={[4, 4, 0, 0]} barSize={40} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-[280px] flex items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
