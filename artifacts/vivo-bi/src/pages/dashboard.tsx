import { useState, useEffect } from "react";
import { DashboardHeader } from "@/components/dashboard/header";
import { KpiRow } from "@/components/dashboard/kpi-row";
import { RevenueTrendChart } from "@/components/dashboard/revenue-trend-chart";
import { BrandSalesChart } from "@/components/dashboard/brand-sales-chart";
import { CategorySalesChart } from "@/components/dashboard/category-sales-chart";
import { ChannelSalesChart } from "@/components/dashboard/channel-sales-chart";
import { InventoryHealthChart } from "@/components/dashboard/inventory-health-chart";
import { RegionSalesChart } from "@/components/dashboard/region-sales-chart";
import { TopProductsTable } from "@/components/dashboard/top-products-table";
import { StorePerformanceTable } from "@/components/dashboard/store-performance-table";

export default function Dashboard() {
  const [isDark, setIsDark] = useState(false);

  // Sync isDark with document class
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class") {
          setIsDark(document.documentElement.classList.contains("dark"));
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true });
    setIsDark(document.documentElement.classList.contains("dark"));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1500px] mx-auto px-5 py-8 md:px-8 md:py-10">
        <DashboardHeader />
        
        <KpiRow />
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
          <div className="lg:col-span-2">
            <RevenueTrendChart isDark={isDark} />
          </div>
          <div className="lg:col-span-1">
             <ChannelSalesChart isDark={isDark} />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
          <BrandSalesChart isDark={isDark} />
          <InventoryHealthChart isDark={isDark} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
          <div className="lg:col-span-1">
             <CategorySalesChart isDark={isDark} />
          </div>
          <div className="lg:col-span-2">
             <RegionSalesChart isDark={isDark} />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
          <TopProductsTable />
          <StorePerformanceTable />
        </div>
      </div>
    </div>
  );
}
