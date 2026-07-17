const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // /loyalty-app/health → JSON liveness probe
  if (url === '/loyalty-app/health' || url === '/loyalty-app/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // /loyalty-app/api/* → 401 (no authenticated session in the canvas preview)
  if (url.startsWith('/loyalty-app/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthenticated' }));
    return;
  }

  // /loyalty-app (bare, no trailing slash) → 301 to /loyalty-app/
  if (url === '/loyalty-app') {
    res.writeHead(301, { Location: '/loyalty-app/' });
    res.end();
    return;
  }

  // Everything else → redirect HTML (canvas preview)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(`Loyalty PWA redirect server listening on port ${PORT}`);
});
