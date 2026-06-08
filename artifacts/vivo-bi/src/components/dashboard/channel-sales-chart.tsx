import { useGetSalesByChannel } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import { CustomTooltip, CustomLegend } from "@/components/ui/chart-utils";
import { CHART_COLOR_LIST } from "@/lib/utils";

export function ChannelSalesChart({ isDark }: { isDark: boolean }) {
  const { data, isLoading, isFetching } = useGetSalesByChannel();
  const loading = isLoading || isFetching;

  return (
    <Card className="shadow-sm border-muted/60">
      <CardHeader className="px-5 pt-5 pb-0 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-serif">Channel Split</CardTitle>
        {!loading && data && data.length > 0 && (
          <CSVLink 
            data={data} 
            filename="channel-sales.csv" 
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
          <Skeleton className="w-full h-[280px] mt-4" />
        ) : data && data.length > 0 ? (
          <div className="flex flex-col items-center">
            <ResponsiveContainer width="100%" height={240} debounce={0}>
              <PieChart>
                <Pie 
                  data={data} 
                  dataKey="revenue" 
                  nameKey="channel" 
                  cx="50%" 
                  cy="50%" 
                  innerRadius={70} 
                  outerRadius={105} 
                  cornerRadius={3} 
                  paddingAngle={2} 
                  isAnimationActive={false} 
                  stroke="none"
                >
                  {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLOR_LIST[index % CHART_COLOR_LIST.length]} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} isAnimationActive={false} />
              </PieChart>
            </ResponsiveContainer>
            {/* Render legend outside ResponsiveContainer for better control */}
            <div className="-mt-2">
               <CustomLegend payload={data.map((d, i) => ({ value: d.channel, color: CHART_COLOR_LIST[i % CHART_COLOR_LIST.length] }))} />
            </div>
          </div>
        ) : (
          <div className="w-full h-[280px] flex items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
