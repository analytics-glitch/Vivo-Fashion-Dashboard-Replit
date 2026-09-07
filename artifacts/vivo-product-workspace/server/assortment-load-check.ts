const baseUrl = process.env.ASSORTMENT_CHECK_URL ?? "http://127.0.0.1:23661/api/workspace/assortment-plan";
const cookie = process.env.ASSORTMENT_CHECK_COOKIE;
const users = Number(process.env.ASSORTMENT_CHECK_USERS ?? 12);
const maxMs = Number(process.env.ASSORTMENT_CHECK_MAX_MS ?? 5000);

if (!cookie) throw new Error("ASSORTMENT_CHECK_COOKIE is required");

const startedAt = performance.now();
const responses = await Promise.all(Array.from({ length: users }, () =>
  fetch(baseUrl, { headers: { Cookie: cookie } })));
const elapsedMs = performance.now() - startedAt;
const failed = responses.filter((response) => !response.ok);
if (failed.length) throw new Error(`${failed.length}/${users} requests failed`);
const payloadSizes = await Promise.all(responses.map(async (response) =>
  Number(response.headers.get("x-payload-bytes") ?? (await response.arrayBuffer()).byteLength)));
if (elapsedMs > maxMs) throw new Error(`${users}-user check took ${elapsedMs.toFixed(0)}ms (limit ${maxMs}ms)`);
console.log(JSON.stringify({
  users,
  elapsedMs: Math.round(elapsedMs),
  maxPayloadBytes: Math.max(...payloadSizes),
  styleCount: Number(responses[0]?.headers.get("x-assortment-styles") ?? 0),
}));