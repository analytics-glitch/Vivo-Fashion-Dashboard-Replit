import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 8090;
const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, "index.html"));

const server = createServer((req, res) => {
  const url = req.url || "/";

  if (req.method === "GET" && url === "/loyalty-app/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && url === "/loyalty-app") {
    res.writeHead(301, { "Location": "/loyalty-app/" });
    res.end();
    return;
  }

  if (url.startsWith("/loyalty-app/api/")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`loyalty-pwa redirect server listening on port ${PORT}`);
});
