import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  layout("routes/_app.tsx", [
    route("dashboard", "routes/dashboard.tsx"),
    route("rewards", "routes/rewards.tsx"),
    route("shop", "routes/shop.tsx"),
    route("shop/product/:handle", "routes/product.tsx"),
    route("cart", "routes/cart.tsx"),
    route("wishlist", "routes/wishlist.tsx"),
    route("orders", "routes/orders.tsx"),
    route("orders/:orderId", "routes/order-detail.tsx"),
    route("referrals", "routes/referrals.tsx"),
    route("profile", "routes/profile.tsx"),
    route("admin", "routes/admin.tsx"),
  ]),
] satisfies RouteConfig;
