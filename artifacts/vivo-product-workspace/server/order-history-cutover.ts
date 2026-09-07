export type OrderWithSource = {
  orderDate: string;
  source: string;
};

export function orderAllowedByHistoryCutover(order: OrderWithSource, odooStartDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(order.orderDate) || !/^\d{4}-\d{2}-\d{2}$/.test(odooStartDate)) return false;
  return order.orderDate >= odooStartDate
    ? order.source === "odoo"
    : order.source === "central_tracker";
}