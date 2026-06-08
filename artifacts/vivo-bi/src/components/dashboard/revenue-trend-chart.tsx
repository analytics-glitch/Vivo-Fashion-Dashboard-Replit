import { useGetRevenueTrend } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import { CustomTooltip, CustomLegend } from "@/components/ui/chart-utils";
import { CHART_COLORS } from "@/lib/utils";

export function RevenueTrendChart({ isDark }: { isDark: boolean }) {
  const { data, isLoading, isFetching } = useGetRevenueTrend();
  const loading = isLoading || isFetching;
  
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "#e5e5e5";
  const tickColor = isDark ? "#98999C" : "#71717a";

  return (
    <Card className="shadow-sm border-muted/60">
      <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-serif">Revenue Trend YoY</CardTitle>
        {!loading && data && data.length > 0 && (
          <CSVLink 
            data={data} 
            filename="revenue-trend.csv" 
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
          <Skeleton className="w-full h-[320px]" />
        ) : data && data.length > 0 ? (
          <ResponsiveContainer width="100%" height={320} debounce={0}>
            <LineChart data={data} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: tickColor }} stroke={tickColor} axisLine={false} tickLine={false} dy={10} />
              <YAxis 
                tickFormatter={(value) => `$${(value / 1000000).toFixed(1)}M`} 
                tick={{ fontSize: 12, fill: tickColor }} 
                stroke={tickColor} 
                axisLine={false} 
                tickLine={false} 
                dx={-10}
              />
              <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ stroke: tickColor, strokeDasharray: '3 3' }} />
              <Legend content={<CustomLegend />} />
              <Line 
                type="monotone" 
                dataKey="currentYear" 
                name="Current Year" 
                stroke={CHART_COLORS.blue} 
                strokeWidth={3} 
                dot={{ r: 3, fill: CHART_COLORS.blue, strokeWidth: 0 }} 
                activeDot={{ r: 6, fill: CHART_COLORS.blue, stroke: '#ffffff', strokeWidth: 2 }} 
                isAnimationActive={false} 
              />
              <Line 
                type="monotone" 
                dataKey="priorYear" 
                name="Prior Year" 
                stroke={CHART_COLORS.purple} 
                strokeWidth={2} 
                strokeDasharray="4 4"
                dot={false} 
                activeDot={{ r: 5, fill: CHART_COLORS.purple, stroke: '#ffffff', strokeWidth: 2 }} 
                isAnimationActive={false} 
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="w-full h-[320px] flex items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
