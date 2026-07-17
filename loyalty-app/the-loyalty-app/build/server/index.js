import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, ServerRouter, UNSAFE_withComponentProps, UNSAFE_withErrorBoundaryProps, UNSAFE_withHydrateFallbackProps, isRouteErrorResponse } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { jsx, jsxs } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region node_modules/@react-router/dev/dist/config/defaults/entry.server.node.tsx
var entry_server_node_exports = /* @__PURE__ */ __exportAll({
	default: () => handleRequest,
	streamTimeout: () => streamTimeout
});
var streamTimeout = 5e3;
function handleRequest(request, responseStatusCode, responseHeaders, routerContext, loadContext) {
	if (request.method.toUpperCase() === "HEAD") return new Response(null, {
		status: responseStatusCode,
		headers: responseHeaders
	});
	return new Promise((resolve, reject) => {
		let shellRendered = false;
		let userAgent = request.headers.get("user-agent");
		let readyOption = userAgent && isbot(userAgent) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";
		let timeoutId = setTimeout(() => abort(), 6e3);
		const { pipe, abort } = renderToPipeableStream(/* @__PURE__ */ jsx(ServerRouter, {
			context: routerContext,
			url: request.url
		}), {
			[readyOption]() {
				shellRendered = true;
				const body = new PassThrough({ final(callback) {
					clearTimeout(timeoutId);
					timeoutId = void 0;
					callback();
				} });
				const stream = createReadableStreamFromReadable(body);
				responseHeaders.set("Content-Type", "text/html");
				pipe(body);
				resolve(new Response(stream, {
					headers: responseHeaders,
					status: responseStatusCode
				}));
			},
			onShellError(error) {
				reject(error);
			},
			onError(error) {
				responseStatusCode = 500;
				if (shellRendered) console.error(error);
			}
		});
	});
}
//#endregion
//#region app/lib/api.ts
/**
* Tiny typed fetch client for the Vivo Loyalty backend.
* Uses cookie-based sessions (credentials: "include").
*/
var API_URL = "".replace(/\/$/, "") || "/loyalty-app";
var ApiError = class extends Error {
	status;
	data;
	constructor(status, message, data) {
		super(message);
		this.status = status;
		this.data = data;
	}
};
async function request(path, init = {}, signal) {
	const res = await fetch(`${API_URL}${path}`, {
		...init,
		signal: signal ?? init.signal,
		credentials: "include",
		headers: {
			...init.body ? { "Content-Type": "application/json" } : {},
			...init.headers ?? {}
		}
	});
	const text = await res.text();
	const data = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const message = data && (data.message || data.error) || `Request failed (${res.status})`;
		throw new ApiError(res.status, message, data);
	}
	return data;
}
var api = {
	get: (path, signal) => request(path, {}, signal),
	post: (path, body) => request(path, {
		method: "POST",
		body: body ? JSON.stringify(body) : void 0
	}),
	patch: (path, body) => request(path, {
		method: "PATCH",
		body: body ? JSON.stringify(body) : void 0
	}),
	put: (path, body) => request(path, {
		method: "PUT",
		body: body ? JSON.stringify(body) : void 0
	}),
	del: (path) => request(path, { method: "DELETE" })
};
var auth = {
	me: (signal) => api.get("/api/auth/me", signal),
	status: () => api.get("/api/auth/status"),
	requestOtp: (email, referralCode) => api.post("/api/auth/otp/request", {
		email,
		referralCode
	}),
	verifyOtp: (email, code, referralCode) => api.post("/api/auth/otp/verify", {
		email,
		code,
		referralCode
	}),
	googleToken: (credential, referralCode) => api.post("/api/auth/google/token", {
		credential,
		referralCode
	}),
	logout: () => api.post("/api/auth/logout"),
	heartbeat: (installed, version) => api.post("/api/auth/heartbeat", {
		installed,
		version
	}),
	googleRedirectUrl: (referralCode, next = "/dashboard") => `${API_URL}/api/auth/google?next=${encodeURIComponent(next)}${referralCode ? `&ref=${encodeURIComponent(referralCode)}` : ""}`
};
var shop = {
	collections: () => api.get("/api/shop/collections"),
	products: (handle) => api.get(`/api/shop/collections/${encodeURIComponent(handle)}/products`),
	product: (handle) => api.get(`/api/shop/products/${encodeURIComponent(handle)}`),
	cartGet: (id) => api.get(`/api/shop/cart?id=${encodeURIComponent(id)}`),
	cartActive: () => api.get("/api/shop/cart/active"),
	cartAdd: (variantId, quantity, cartId) => api.post("/api/shop/cart/add", {
		variantId,
		quantity,
		cartId
	}),
	cartUpdate: (cartId, lineId, quantity) => api.post("/api/shop/cart/update", {
		cartId,
		lineId,
		quantity
	}),
	cartRemove: (cartId, lineId) => api.post("/api/shop/cart/remove", {
		cartId,
		lineId
	}),
	wishlist: () => api.get("/api/shop/wishlist"),
	wishlistAdd: (item) => api.post("/api/shop/wishlist", item),
	wishlistRemove: (handle) => api.post("/api/shop/wishlist/remove", { handle })
};
//#endregion
//#region app/lib/auth.tsx
var AuthContext = createContext(null);
function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [loading, setLoading] = useState(true);
	const refresh = useCallback(async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1e4);
		try {
			const { user } = await auth.me(controller.signal);
			setUser(user);
			return user;
		} catch (e) {
			if (e instanceof Error && e.name !== "AbortError") console.error("[auth] refresh failed:", e.message);
			setUser(null);
			return null;
		} finally {
			clearTimeout(timer);
			setLoading(false);
		}
	}, []);
	const logout = useCallback(async () => {
		try {
			await auth.logout();
		} finally {
			setUser(null);
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	return /* @__PURE__ */ jsx(AuthContext.Provider, {
		value: {
			user,
			loading,
			refresh,
			setUser,
			logout
		},
		children
	});
}
function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within AuthProvider");
	return ctx;
}
//#endregion
//#region app/lib/cart.tsx
var STORAGE_KEY = "vivo_cart_id";
var CartContext = createContext(null);
function CartProvider({ children }) {
	const { user } = useAuth();
	const [cart, setCart] = useState(null);
	const [busy, setBusy] = useState(false);
	const persist = (c) => {
		setCart(c);
		if (c?.id) localStorage.setItem(STORAGE_KEY, c.id);
		else localStorage.removeItem(STORAGE_KEY);
	};
	useEffect(() => {
		if (!user) {
			setCart(null);
			return;
		}
		shop.cartActive().then(async (r) => {
			if (r.cart) return persist(r.cart);
			const localId = localStorage.getItem(STORAGE_KEY);
			if (localId) {
				const local = await shop.cartGet(localId).catch(() => null);
				if (local?.cart) return persist(local.cart);
			}
			persist(null);
		}).catch(() => {});
	}, [user?.id]);
	const add = useCallback(async (variantId, quantity = 1) => {
		setBusy(true);
		try {
			const r = await shop.cartAdd(variantId, quantity, cart?.id);
			persist(r.cart);
		} finally {
			setBusy(false);
		}
	}, [cart?.id]);
	const update = useCallback(async (lineId, quantity) => {
		if (!cart?.id) return;
		setBusy(true);
		try {
			const r = await shop.cartUpdate(cart.id, lineId, quantity);
			persist(r.cart);
		} finally {
			setBusy(false);
		}
	}, [cart?.id]);
	const remove = useCallback(async (lineId) => {
		if (!cart?.id) return;
		setBusy(true);
		try {
			const r = await shop.cartRemove(cart.id, lineId);
			persist(r.cart);
		} finally {
			setBusy(false);
		}
	}, [cart?.id]);
	const checkout = useCallback(() => {
		if (cart?.checkoutUrl) window.location.href = cart.checkoutUrl;
	}, [cart?.checkoutUrl]);
	return /* @__PURE__ */ jsx(CartContext.Provider, {
		value: {
			cart,
			count: cart?.totalQuantity ?? 0,
			busy,
			add,
			update,
			remove,
			checkout
		},
		children
	});
}
//#endregion
//#region app/lib/wishlist.tsx
var WishlistContext = createContext(null);
function WishlistProvider({ children }) {
	const { user } = useAuth();
	const [items, setItems] = useState([]);
	useEffect(() => {
		if (!user) {
			setItems([]);
			return;
		}
		shop.wishlist().then((r) => setItems(r.items)).catch(() => {});
	}, [user?.id]);
	const has = useCallback((handle) => items.some((i) => i.handle === handle), [items]);
	const toggle = useCallback(async (item) => {
		const saved = items.some((i) => i.handle === item.handle);
		setItems((prev) => saved ? prev.filter((i) => i.handle !== item.handle) : [item, ...prev]);
		try {
			const r = saved ? await shop.wishlistRemove(item.handle) : await shop.wishlistAdd({
				handle: item.handle,
				title: item.title,
				image: item.image,
				price: item.price,
				currency: item.currency
			});
			setItems(r.items);
		} catch {
			setItems((prev) => saved ? [item, ...prev] : prev.filter((i) => i.handle !== item.handle));
		}
		return !saved;
	}, [items]);
	const remove = useCallback(async (handle) => {
		setItems((prev) => prev.filter((i) => i.handle !== handle));
		try {
			const r = await shop.wishlistRemove(handle);
			setItems(r.items);
		} catch {}
	}, []);
	return /* @__PURE__ */ jsx(WishlistContext.Provider, {
		value: {
			items,
			count: items.length,
			has,
			toggle,
			remove
		},
		children
	});
}
//#endregion
//#region app/components/toast.tsx
var ToastContext = createContext(null);
var counter = 0;
function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);
	const show = useCallback((message, kind = "info") => {
		const id = ++counter;
		setToasts((t) => [...t, {
			id,
			kind,
			message
		}]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
	}, []);
	return /* @__PURE__ */ jsxs(ToastContext.Provider, {
		value: { show },
		children: [children, /* @__PURE__ */ jsx("div", {
			className: "pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4 safe-top",
			children: toasts.map((t) => /* @__PURE__ */ jsxs("div", {
				className: "rise pointer-events-auto flex max-w-sm items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-white shadow-lg",
				style: { background: t.kind === "success" ? "#16a34a" : t.kind === "error" ? "#dc2626" : "#4f46e5" },
				children: [/* @__PURE__ */ jsx("span", { children: t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "•" }), t.message]
			}, t.id))
		})]
	});
}
//#endregion
//#region app/root.tsx
var root_exports = /* @__PURE__ */ __exportAll({
	ErrorBoundary: () => ErrorBoundary,
	HydrateFallback: () => HydrateFallback,
	Layout: () => Layout,
	default: () => root_default,
	links: () => links,
	meta: () => meta
});
if (typeof window !== "undefined") window.addEventListener("vite:preloadError", (event) => {
	console.warn("[vivo] vite:preloadError caught:", event.detail);
	const key = `vivo_chunk_reload_${Math.floor(Date.now() / 6e4)}`;
	if (!sessionStorage.getItem(key)) {
		sessionStorage.setItem(key, "1");
		window.location.reload();
	} else console.error("[vivo] chunk reload already attempted this minute — not looping");
});
var links = () => [
	{
		rel: "preconnect",
		href: "https://fonts.googleapis.com"
	},
	{
		rel: "preconnect",
		href: "https://fonts.gstatic.com",
		crossOrigin: "anonymous"
	},
	{
		rel: "stylesheet",
		href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap"
	},
	{
		rel: "manifest",
		href: "/loyalty-app/manifest.webmanifest"
	},
	{
		rel: "icon",
		href: "/loyalty-app/icons/icon-192.png",
		type: "image/png"
	},
	{
		rel: "apple-touch-icon",
		href: "/loyalty-app/icons/icon-180.png"
	}
];
var meta = () => [
	{ title: "Vivo Loyalty" },
	{
		name: "description",
		content: "Earn points, climb tiers, and unlock exclusive rewards."
	},
	{
		name: "theme-color",
		content: "#0a0a0f"
	},
	{
		name: "apple-mobile-web-app-capable",
		content: "yes"
	},
	{
		name: "apple-mobile-web-app-status-bar-style",
		content: "black-translucent"
	},
	{
		name: "apple-mobile-web-app-title",
		content: "Vivo Loyalty"
	},
	{
		name: "mobile-web-app-capable",
		content: "yes"
	}
];
function Layout({ children }) {
	return /* @__PURE__ */ jsxs("html", {
		lang: "en",
		children: [/* @__PURE__ */ jsxs("head", { children: [
			/* @__PURE__ */ jsx("meta", { charSet: "utf-8" }),
			/* @__PURE__ */ jsx("meta", {
				name: "viewport",
				content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1"
			}),
			/* @__PURE__ */ jsx(Meta, {}),
			/* @__PURE__ */ jsx(Links, {})
		] }), /* @__PURE__ */ jsxs("body", { children: [
			children,
			/* @__PURE__ */ jsx(ScrollRestoration, {}),
			/* @__PURE__ */ jsx(Scripts, {})
		] })]
	});
}
var root_default = UNSAFE_withComponentProps(function App() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("/loyalty-app/sw.js", { scope: "/loyalty-app/" }).then((reg) => reg.update()).catch(() => {});
	}, []);
	return /* @__PURE__ */ jsx(ToastProvider, { children: /* @__PURE__ */ jsx(AuthProvider, { children: /* @__PURE__ */ jsx(CartProvider, { children: /* @__PURE__ */ jsx(WishlistProvider, { children: /* @__PURE__ */ jsx(Outlet, {}) }) }) }) });
});
var HydrateFallback = UNSAFE_withHydrateFallbackProps(function HydrateFallback() {
	return /* @__PURE__ */ jsx("div", {
		className: "grid min-h-[100dvh] place-items-center bg-[var(--bg)] px-8",
		children: /* @__PURE__ */ jsx("img", {
			src: "/loyalty-app/icons/vivo-icon.png",
			alt: "Vivo Loyalty",
			className: "w-40 max-w-[55%] animate-pulse rounded-3xl"
		})
	});
});
var ErrorBoundary = UNSAFE_withErrorBoundaryProps(function ErrorBoundary({ error }) {
	let message = "Something went wrong";
	let details = "An unexpected error occurred.";
	if (isRouteErrorResponse(error)) {
		message = error.status === 404 ? "Page not found" : "Error";
		details = error.status === 404 ? "We couldn't find that page." : error.statusText || details;
	} else if (error instanceof Error) details = error.message;
	return /* @__PURE__ */ jsx("main", {
		className: "grid min-h-[100dvh] place-items-center p-6 text-center",
		children: /* @__PURE__ */ jsxs("div", { children: [
			/* @__PURE__ */ jsx("h1", {
				className: "text-2xl font-bold",
				children: message
			}),
			/* @__PURE__ */ jsx("p", {
				className: "mt-2 text-muted",
				children: details
			}),
			/* @__PURE__ */ jsx("a", {
				href: "/loyalty-app/dashboard",
				className: "mt-6 inline-block rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white",
				children: "Back to home"
			})
		] })
	});
});
//#endregion
//#region \0virtual:react-router/server-manifest
var server_manifest_default = {
	"entry": {
		"module": "/loyalty-app/assets/entry.client-CDh8JjA6.js",
		"imports": ["/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js", "/loyalty-app/assets/errorBoundaries-1jb_otEO.js"],
		"css": []
	},
	"routes": {
		"root": {
			"id": "root",
			"parentId": void 0,
			"path": "",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": true,
			"module": "/loyalty-app/assets/root-D2oZHwGF.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js",
				"/loyalty-app/assets/root-B6xYFDCZ.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/wishlist-n2_1ffIy.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/api-YMwMEqBz.js"
			],
			"css": ["/loyalty-app/assets/root-CMRNd3Kk.css"],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/home": {
			"id": "routes/home",
			"parentId": "root",
			"path": void 0,
			"index": true,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/home-B6swj_qd.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/api-YMwMEqBz.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/login": {
			"id": "routes/login",
			"parentId": "root",
			"path": "login",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/login-ClvB4vtW.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/_app": {
			"id": "routes/_app",
			"parentId": "root",
			"path": void 0,
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/_app-CmUyuU5Y.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/root-B6xYFDCZ.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/wishlist-n2_1ffIy.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js"
			],
			"css": ["/loyalty-app/assets/root-CMRNd3Kk.css"],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/dashboard": {
			"id": "routes/dashboard",
			"parentId": "routes/_app",
			"path": "dashboard",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/dashboard-ButR5ybL.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/rewards": {
			"id": "routes/rewards",
			"parentId": "routes/_app",
			"path": "rewards",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/rewards-Dsn1q3A6.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/shop": {
			"id": "routes/shop",
			"parentId": "routes/_app",
			"path": "shop",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/shop-fs-voyIm.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/wishlist-n2_1ffIy.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js",
				"/loyalty-app/assets/auth-CACReBEY.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/product": {
			"id": "routes/product",
			"parentId": "routes/_app",
			"path": "shop/product/:handle",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/product-BbYbWeVv.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/wishlist-n2_1ffIy.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/auth-CACReBEY.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/cart": {
			"id": "routes/cart",
			"parentId": "routes/_app",
			"path": "cart",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/cart-DN9FTg6Q.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/wishlist": {
			"id": "routes/wishlist",
			"parentId": "routes/_app",
			"path": "wishlist",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/wishlist-Bdbu44JW.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/cart-BFwddb8r.js",
				"/loyalty-app/assets/wishlist-n2_1ffIy.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js",
				"/loyalty-app/assets/auth-CACReBEY.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/orders": {
			"id": "routes/orders",
			"parentId": "routes/_app",
			"path": "orders",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/orders-BbheCRFQ.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/order-detail": {
			"id": "routes/order-detail",
			"parentId": "routes/_app",
			"path": "orders/:orderId",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/order-detail-DYDwr_8f.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/referrals": {
			"id": "routes/referrals",
			"parentId": "routes/_app",
			"path": "referrals",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/referrals-DcZMlyCs.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/profile": {
			"id": "routes/profile",
			"parentId": "routes/_app",
			"path": "profile",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/profile-BqnK4KcR.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/toast-Dq2PL5hw.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/admin": {
			"id": "routes/admin",
			"parentId": "routes/_app",
			"path": "admin",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/admin-DZKRdg8H.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/admin-rewards": {
			"id": "routes/admin-rewards",
			"parentId": "routes/_app",
			"path": "admin/rewards",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/loyalty-app/assets/admin-rewards-DU_rRxYz.js",
			"imports": [
				"/loyalty-app/assets/jsx-runtime-9B-Vw_gV.js",
				"/loyalty-app/assets/lib-BjbtTOEi.js",
				"/loyalty-app/assets/api-YMwMEqBz.js",
				"/loyalty-app/assets/auth-CACReBEY.js",
				"/loyalty-app/assets/icons-BNPGcT5k.js",
				"/loyalty-app/assets/format-C239CPVp.js",
				"/loyalty-app/assets/errorBoundaries-1jb_otEO.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		}
	},
	"url": "/loyalty-app/assets/manifest-7dfde1bf.js",
	"version": "7dfde1bf",
	"sri": void 0
};
//#endregion
//#region \0virtual:react-router/server-build
var route1 = { default: () => null };
var route2 = { default: () => null };
var route3 = { default: () => null };
var route4 = { default: () => null };
var route5 = { default: () => null };
var route6 = { default: () => null };
var route7 = { default: () => null };
var route8 = { default: () => null };
var route9 = { default: () => null };
var route10 = { default: () => null };
var route11 = { default: () => null };
var route12 = { default: () => null };
var route13 = { default: () => null };
var route14 = { default: () => null };
var route15 = { default: () => null };
var assetsBuildDirectory = "build/client";
var basename = "/loyalty-app/";
var future = { "unstable_optimizeDeps": false };
var ssr = false;
var isSpaMode = true;
var prerender = [];
var routeDiscovery = { "mode": "initial" };
var publicPath = "/loyalty-app/";
var entry = { module: entry_server_node_exports };
var routes = {
	"root": {
		id: "root",
		parentId: void 0,
		path: "",
		index: void 0,
		caseSensitive: void 0,
		module: root_exports
	},
	"routes/home": {
		id: "routes/home",
		parentId: "root",
		path: void 0,
		index: true,
		caseSensitive: void 0,
		module: route1
	},
	"routes/login": {
		id: "routes/login",
		parentId: "root",
		path: "login",
		index: void 0,
		caseSensitive: void 0,
		module: route2
	},
	"routes/_app": {
		id: "routes/_app",
		parentId: "root",
		path: void 0,
		index: void 0,
		caseSensitive: void 0,
		module: route3
	},
	"routes/dashboard": {
		id: "routes/dashboard",
		parentId: "routes/_app",
		path: "dashboard",
		index: void 0,
		caseSensitive: void 0,
		module: route4
	},
	"routes/rewards": {
		id: "routes/rewards",
		parentId: "routes/_app",
		path: "rewards",
		index: void 0,
		caseSensitive: void 0,
		module: route5
	},
	"routes/shop": {
		id: "routes/shop",
		parentId: "routes/_app",
		path: "shop",
		index: void 0,
		caseSensitive: void 0,
		module: route6
	},
	"routes/product": {
		id: "routes/product",
		parentId: "routes/_app",
		path: "shop/product/:handle",
		index: void 0,
		caseSensitive: void 0,
		module: route7
	},
	"routes/cart": {
		id: "routes/cart",
		parentId: "routes/_app",
		path: "cart",
		index: void 0,
		caseSensitive: void 0,
		module: route8
	},
	"routes/wishlist": {
		id: "routes/wishlist",
		parentId: "routes/_app",
		path: "wishlist",
		index: void 0,
		caseSensitive: void 0,
		module: route9
	},
	"routes/orders": {
		id: "routes/orders",
		parentId: "routes/_app",
		path: "orders",
		index: void 0,
		caseSensitive: void 0,
		module: route10
	},
	"routes/order-detail": {
		id: "routes/order-detail",
		parentId: "routes/_app",
		path: "orders/:orderId",
		index: void 0,
		caseSensitive: void 0,
		module: route11
	},
	"routes/referrals": {
		id: "routes/referrals",
		parentId: "routes/_app",
		path: "referrals",
		index: void 0,
		caseSensitive: void 0,
		module: route12
	},
	"routes/profile": {
		id: "routes/profile",
		parentId: "routes/_app",
		path: "profile",
		index: void 0,
		caseSensitive: void 0,
		module: route13
	},
	"routes/admin": {
		id: "routes/admin",
		parentId: "routes/_app",
		path: "admin",
		index: void 0,
		caseSensitive: void 0,
		module: route14
	},
	"routes/admin-rewards": {
		id: "routes/admin-rewards",
		parentId: "routes/_app",
		path: "admin/rewards",
		index: void 0,
		caseSensitive: void 0,
		module: route15
	}
};
var allowedActionOrigins = false;
//#endregion
export { allowedActionOrigins, server_manifest_default as assets, assetsBuildDirectory, basename, entry, future, isSpaMode, prerender, publicPath, routeDiscovery, routes, ssr };
