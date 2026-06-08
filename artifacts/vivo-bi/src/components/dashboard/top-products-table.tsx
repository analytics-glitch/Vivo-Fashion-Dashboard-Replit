import { useState } from "react";
import { useGetTopProducts } from "@workspace/api-client-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent } from "@/lib/utils";
import type { ProductSales } from "@workspace/api-client-react/src/generated/api.schemas";

export function TopProductsTable() {
  const { data, isLoading, isFetching } = useGetTopProducts();
  const loading = isLoading || isFetching;

  const [sorting, setSorting] = useState<SortingState>([
    { id: "revenue", desc: true }
  ]);

  const columns: ColumnDef<ProductSales>[] = [
    {
      accessorKey: "name",
      header: "Product",
      cell: ({ row }) => (
        <div>
          <p className="font-medium text-[13px]">{row.original.name}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{row.original.sku}</p>
        </div>
      ),
    },
    {
      accessorKey: "brand",
      header: "Brand",
      cell: ({ row }) => <span className="text-[13px]">{row.original.brand}</span>,
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ row }) => <span className="text-[13px] text-muted-foreground">{row.original.category}</span>,
    },
    {
      accessorKey: "revenue",
      header: "Revenue",
      cell: ({ row }) => <span className="font-medium text-[13px]">{formatCurrency(row.original.revenue)}</span>,
    },
    {
      accessorKey: "units",
      header: "Units",
      cell: ({ row }) => <span className="text-[13px]">{row.original.units.toLocaleString()}</span>,
    },
    {
      accessorKey: "marginPct",
      header: "Margin",
      cell: ({ row }) => (
        <span className="text-[13px] text-emerald-600 dark:text-emerald-500 font-medium">
          {formatPercent(row.original.marginPct)}
        </span>
      ),
    },
  ];

  const tableData = data || [];

  const table = useReactTable({
    data: tableData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 5 } },
  });

  return (
    <Card className="shadow-sm border-muted/60 h-full flex flex-col">
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="text-base font-serif">Top Performing Products</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 flex flex-col">
        {loading ? (
          <div className="space-y-2 p-5 pt-0">
            <Skeleton className="h-10 w-full" />
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-[48px] w-full" />)}
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto">
              <Table>
                <TableHeader className="bg-muted/30">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id} className="border-border">
                      {headerGroup.headers.map((header) => (
                        <TableHead 
                          key={header.id} 
                          onClick={header.column.getToggleSortingHandler()} 
                          className="cursor-pointer select-none text-[12px] h-9"
                        >
                          <div className="flex items-center gap-1">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getIsSorted() === "asc" ? " ↑" : header.column.getIsSorted() === "desc" ? " ↓" : ""}
                          </div>
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.length > 0 ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} className="border-border/50">
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id} className="py-2.5 px-4">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                        No products found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {tableData.length > 5 && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between mt-auto">
                <div className="text-[12px] text-muted-foreground">
                  Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{" "}
                  {Math.min((table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize, tableData.length)}{" "}
                  of {tableData.length}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-[12px] px-3" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>Prev</Button>
                  <Button variant="outline" size="sm" className="h-7 text-[12px] px-3" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
