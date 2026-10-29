import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutes, matchRoute } from './api.js';
import { createDefaultRegistry } from './retailers/registry.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(registry = createDefaultRegistry()) {
  const routes = createRoutes(registry);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const match = matchRoute(routes, req.method, url.pathname);
        if (!match) return sendJson(res, 404, { error: 'Not found' });
        const body = await match.route.handler({ params: match.params, query: url.searchParams, req });
        return sendJson(res, 200, body);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      if (await serveStatic(url.pathname, res)) return;
      // SPA fallback
      if (await serveStatic('/index.html', res)) return;
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: status >= 500 && !err.status ? 'Internal server error' : err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const registry = createDefaultRegistry();
  registry.tracker.prune();
  setInterval(() => registry.tracker.prune(), 24 * 60 * 60 * 1000).unref();
  createApp(registry).listen(port, () => {
    const modes = registry.list().map((r) => `${r.name} (${r.mode})`).join(', ');
    console.log(`Clearance Tracker running at http://localhost:${port} — retailers: ${modes}`);
  });
}
