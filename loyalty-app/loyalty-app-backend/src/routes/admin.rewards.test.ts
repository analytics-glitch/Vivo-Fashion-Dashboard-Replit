import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import { ZodError } from "zod";
import type { SessionUser } from "../plugins/auth.js";

/**
 * Integration tests for the admin rewards CRUD routes (admin.ts).
 *
 * Strategy: build a minimal real Fastify instance with the actual adminRoutes
 * registered, a mock Prisma decoration, and a real JWT stack. Tests call the
 * real route code via app.inject so route wiring, request parsing, hooks
 * (requireAdmin), and error shaping are all exercised against production code.
 *
 * No real DB connection is opened — app.prisma is replaced with an in-memory
 * store that mirrors the Prisma surface the reward handlers actually use.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = "test-secret-that-is-at-least-32-chars-long!!";
const BASE = "/admin";

// ── In-memory Prisma mock ────────────────────────────────────────────────────

interface RewardRow {
  id: string;
  title: string;
  description: string;
  pointsCost: number;
  type: string;
  value: number;
  imageUrl: string | null;
  stock: number | null;
  minTierId: string | null;
  sortOrder: number;
  active: boolean;
  _redemptionCount: number;
}

let rowId = 0;
function nextId() { return `r${++rowId}`; }

function buildMockPrisma(seed: RewardRow[] = []) {
  const store = new Map<string, RewardRow>(seed.map((r) => [r.id, r]));

  return {
    reward: {
      findMany: () => Promise.resolve([...store.values()].sort((a, b) => a.sortOrder - b.sortOrder)),
      findUnique: ({ where, include }: any) => {
        const row = store.get(where.id);
        if (!row) return Promise.resolve(null);
        if (include?._count?.select?.redemptions) {
          return Promise.resolve({ ...row, _count: { redemptions: row._redemptionCount } });
        }
        return Promise.resolve({ ...row });
      },
      create: ({ data }: any) => {
        const row: RewardRow = { _redemptionCount: 0, ...data, id: nextId() };
        store.set(row.id, row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: any) => {
        const existing = store.get(where.id)!;
        const updated = { ...existing, ...data };
        store.set(where.id, updated);
        return Promise.resolve(updated);
      },
      delete: ({ where }: any) => {
        const row = store.get(where.id)!;
        store.delete(where.id);
        return Promise.resolve(row);
      },
    },
    customer: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { loginCount: 0 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    _store: store,
  };
}

// ── Test app builder ─────────────────────────────────────────────────────────

async function buildTestApp(prisma: ReturnType<typeof buildMockPrisma>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: TEST_JWT_SECRET,
    cookie: { cookieName: "test_session", signed: false },
    sign: { expiresIn: "1h" },
  });

  // Config stub — only the fields used by adminRoutes (BASE_PATH for onClose path).
  app.decorate("config", {
    JWT_SECRET: TEST_JWT_SECRET,
    SESSION_COOKIE: "test_session",
    BASE_PATH: "",
    COOKIE_SECURE: false,
    NODE_ENV: "test",
    FRONTEND_DIST: "/tmp/nonexistent",
  } as any);

  // Prisma mock.
  app.decorate("prisma", prisma as any);

  // Real requireAdmin logic (mirrors auth.ts).
  app.decorate("requireAdmin", async (req: any, reply: any) => {
    try { await req.jwtVerify(); } catch { return reply.unauthorized("You must be signed in."); }
    if (req.user.role !== "ADMIN") return reply.forbidden("Admin access required.");
  });

  // ZodError → 400 (mirrors app.ts error handler).
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "Invalid request.",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const e = error as any;
    if (e.statusCode) return reply.status(e.statusCode).send({ error: e.name, message: e.message });
    return reply.status(500).send({ error: "InternalServerError", message: "Something went wrong." });
  });

  // Real admin routes.
  const { default: adminRoutes } = await import("./admin.js");
  await app.register(adminRoutes, { prefix: BASE });

  await app.ready();
  return app;
}

// ── JWT helpers ──────────────────────────────────────────────────────────────

function signToken(app: FastifyInstance, payload: SessionUser): string {
  return app.jwt.sign(payload);
}

const ADMIN_USER: SessionUser = { sub: "admin-1", email: "admin@test.com", role: "ADMIN" };
const CUSTOMER_USER: SessionUser = { sub: "cust-1", email: "cust@test.com", role: "CUSTOMER" };

// ── Sample body ───────────────────────────────────────────────────────────────

const VALID_BODY = {
  title: "10% Off Your Next Purchase",
  description: "Get 10% off any single item.",
  pointsCost: 500,
  type: "PERCENT_DISCOUNT",
  value: 10,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /admin/rewards", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof buildMockPrisma>;

  beforeEach(async () => {
    rowId = 0;
    prisma = buildMockPrisma();
    app = await buildTestApp(prisma);
  });
  afterEach(() => app.close());

  it("returns 401 when no token is provided", async () => {
    const res = await app.inject({ method: "GET", url: `${BASE}/rewards` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const token = signToken(app, CUSTOMER_USER);
    const res = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with an empty list when no rewards exist", async () => {
    const token = signToken(app, ADMIN_USER);
    const res = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rewards: [] });
  });

  it("returns all rewards including inactive ones", async () => {
    const seeded: RewardRow[] = [
      { id: "s1", title: "Active", description: "d", pointsCost: 100, type: "FIXED_DISCOUNT", value: 5, imageUrl: null, stock: null, minTierId: null, sortOrder: 0, active: true, _redemptionCount: 0 },
      { id: "s2", title: "Inactive", description: "d", pointsCost: 200, type: "FREE_SHIPPING", value: 0, imageUrl: null, stock: null, minTierId: null, sortOrder: 1, active: false, _redemptionCount: 2 },
    ];
    prisma = buildMockPrisma(seeded);
    app = await buildTestApp(prisma);
    const token = signToken(app, ADMIN_USER);
    const res = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rewards).toHaveLength(2);
    expect(body.rewards.map((r: any) => r.active)).toEqual(expect.arrayContaining([true, false]));
  });
});

describe("POST /admin/rewards", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof buildMockPrisma>;

  beforeEach(async () => {
    rowId = 0;
    prisma = buildMockPrisma();
    app = await buildTestApp(prisma);
  });
  afterEach(() => app.close());

  async function create(body: unknown, token?: string) {
    const t = token ?? signToken(app, ADMIN_USER);
    return app.inject({
      method: "POST", url: `${BASE}/rewards`,
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("creates a reward and returns 201 with the new record", async () => {
    const res = await create(VALID_BODY);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reward).toMatchObject({ title: VALID_BODY.title, pointsCost: 500, type: "PERCENT_DISCOUNT", active: true });
    expect(body.reward.id).toBeDefined();
  });

  it("defaults active=true when omitted", async () => {
    const { active: _omit, ...noActive } = VALID_BODY as any;
    const res = await create(noActive);
    expect(res.statusCode).toBe(201);
    expect(res.json().reward.active).toBe(true);
  });

  it("defaults sortOrder=0 when omitted", async () => {
    const res = await create(VALID_BODY);
    expect(res.json().reward.sortOrder).toBe(0);
  });

  it("persists the reward so GET returns it", async () => {
    await create(VALID_BODY);
    const token = signToken(app, ADMIN_USER);
    const listRes = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    expect(listRes.json().rewards).toHaveLength(1);
  });

  it("accepts value=0 for FREE_SHIPPING", async () => {
    const res = await create({ ...VALID_BODY, type: "FREE_SHIPPING", value: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json().reward.value).toBe(0);
  });

  it("returns 400 for pointsCost=0 (below min:1)", async () => {
    const res = await create({ ...VALID_BODY, pointsCost: 0 });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for negative stock", async () => {
    const res = await create({ ...VALID_BODY, stock: -1 });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an unknown reward type", async () => {
    const res = await create({ ...VALID_BODY, type: "MYSTERY_BOX" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await app.inject({
      method: "POST", url: `${BASE}/rewards`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /admin/rewards/:id", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof buildMockPrisma>;
  let existingId: string;

  beforeEach(async () => {
    rowId = 0;
    prisma = buildMockPrisma();
    app = await buildTestApp(prisma);
    // Seed one reward.
    const token = signToken(app, ADMIN_USER);
    const res = await app.inject({
      method: "POST", url: `${BASE}/rewards`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(VALID_BODY),
    });
    existingId = res.json().reward.id;
  });
  afterEach(() => app.close());

  async function patch(id: string, body: unknown) {
    const token = signToken(app, ADMIN_USER);
    return app.inject({
      method: "PATCH", url: `${BASE}/rewards/${id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("updates the title and returns the updated reward", async () => {
    const res = await patch(existingId, { title: "New Title" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reward.title).toBe("New Title");
    expect(body.reward.pointsCost).toBe(500); // unchanged
  });

  it("toggles active from true to false", async () => {
    const res = await patch(existingId, { active: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().reward.active).toBe(false);
  });

  it("toggles active from false back to true", async () => {
    await patch(existingId, { active: false });
    const res = await patch(existingId, { active: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().reward.active).toBe(true);
  });

  it("updates pointsCost independently", async () => {
    const res = await patch(existingId, { pointsCost: 999 });
    expect(res.json().reward.pointsCost).toBe(999);
  });

  it("sets stock to a specific value", async () => {
    const res = await patch(existingId, { stock: 50 });
    expect(res.json().reward.stock).toBe(50);
  });

  it("returns 404 for a non-existent reward", async () => {
    const res = await patch("does-not-exist", { title: "X" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a patch with negative stock", async () => {
    const res = await patch(existingId, { stock: -5 });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await app.inject({
      method: "PATCH", url: `${BASE}/rewards/${existingId}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "Sneaky" }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /admin/rewards/:id", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof buildMockPrisma>;
  let freeId: string;

  beforeEach(async () => {
    rowId = 0;
    prisma = buildMockPrisma([
      {
        id: "redeemed",
        title: "Redeemed Reward",
        description: "already used",
        pointsCost: 200,
        type: "FIXED_DISCOUNT",
        value: 20,
        imageUrl: null,
        stock: null,
        minTierId: null,
        sortOrder: 1,
        active: true,
        _redemptionCount: 3,
      },
    ]);
    app = await buildTestApp(prisma);
    // Seed one reward with no redemptions.
    const token = signToken(app, ADMIN_USER);
    const res = await app.inject({
      method: "POST", url: `${BASE}/rewards`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(VALID_BODY),
    });
    freeId = res.json().reward.id;
  });
  afterEach(() => app.close());

  async function del(id: string) {
    const token = signToken(app, ADMIN_USER);
    return app.inject({ method: "DELETE", url: `${BASE}/rewards/${id}`, headers: { authorization: `Bearer ${token}` } });
  }

  it("deletes a reward with no redemptions and returns ok:true", async () => {
    const res = await del(freeId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("removes the reward so GET no longer returns it", async () => {
    await del(freeId);
    const token = signToken(app, ADMIN_USER);
    const listRes = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    const ids = listRes.json().rewards.map((r: any) => r.id);
    expect(ids).not.toContain(freeId);
  });

  it("returns 404 for a non-existent reward", async () => {
    const res = await del("ghost-id");
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 and refuses to delete a reward that has redemptions", async () => {
    const res = await del("redeemed");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot be deleted/i);
  });

  it("keeps the reward in the store when deletion is blocked by redemptions", async () => {
    await del("redeemed");
    const token = signToken(app, ADMIN_USER);
    const listRes = await app.inject({ method: "GET", url: `${BASE}/rewards`, headers: { authorization: `Bearer ${token}` } });
    const ids = listRes.json().rewards.map((r: any) => r.id);
    expect(ids).toContain("redeemed");
  });

  it("returns 401 without a token", async () => {
    const res = await app.inject({ method: "DELETE", url: `${BASE}/rewards/${freeId}` });
    expect(res.statusCode).toBe(401);
  });
});
