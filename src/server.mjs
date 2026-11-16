import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, saveSnapshot, selectData, briefing, projectDir, dataDir } from './data.mjs';
import { syncGarmin, GarminError } from './garmin.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 16 * 1024;
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
export function createApp({ directory, fetchImpl, syncImpl = syncGarmin } = {}) {
  const csrf = randomBytes(32).toString('hex');
  let syncing = false;
  const app = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const port = app.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Use the localhost address printed by the app.' });
    const origin = req.headers.origin;
    if ((origin && !allowedHosts.map(h => `http://${h}`).includes(origin))
      || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = Number(url.searchParams.get('days') || 30);
    if (url.pathname.startsWith('/api/') && (!Number.isInteger(days) || days < 1 || days > 365)) {
      return json(res, 400, { error: 'Choose a range between 1 and 365 days.' });
    }
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
    if (req.method === 'POST') {
      const given = req.headers['x-cadence-token'];
      if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)
        || !timingSafeEqual(Buffer.from(given), Buffer.from(csrf))) return json(res, 403, { error: 'Reload the app before continuing.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Expected JSON.' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        return json(res, 200, { csrf, syncing, projectDir, dataFile: join(directory || dataDir, 'snapshot.json'),
          nodePath: process.execPath });
      }
      if (req.method === 'GET' && ['/api/data', '/api/export', '/api/briefing'].includes(url.pathname)) {
        const data = selectData(await loadSnapshot(directory), days);
        if (url.pathname === '/api/briefing') return json(res, 200, { text: briefing(data) });
        if (url.pathname === '/api/export') res.setHeader('Content-Disposition', 'attachment; filename="cadence-training-data.json"');
        return json(res, 200, data);
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        if (syncing) return json(res, 409, { error: 'A sync is already running. Wait for it to finish.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > MAX_BODY) return json(res, 413, { error: 'Request too large.' });
        }
        let input;
        try { input = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        body = '';
        if (typeof input.key !== 'string' || input.key.trim().length < 8 || input.key.length > 4096 || /[\r\n]/.test(input.key)) {
          return json(res, 400, { error: 'Enter your Garmin Personal API key.' });
        }
        if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) return json(res, 400, { error: 'Invalid sync range.' });
        // The body is read asynchronously; another request may have started a sync in the meantime.
        if (syncing) return json(res, 409, { error: 'A sync is already running. Wait for it to finish.' });
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Browser disconnected.')); });
        syncing = true;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        const emit = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
        try {
          const updated = await syncImpl(await loadSnapshot(directory), input.key.trim(), {
            days: input.days, full: input.full === true, signal: controller.signal, fetchImpl,
            onProgress: p => emit({ type: 'progress', ...p }),
          });
          if (!controller.signal.aborted) {
            await saveSnapshot(updated, directory);
            emit({ type: 'done', sync: updated.sync });
          }
        } catch (e) {
          emit({ type: 'error', error: e instanceof GarminError ? e.message : 'Sync failed. Existing local data has been retained.', status: e.status || 500 });
        } finally { syncing = false; input.key = null; res.end(); }
        return;
      }
      if (req.method === 'GET') {
        const files = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
        const file = files[url.pathname];
        if (file) {
          const mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript';
          res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
          return res.end(await readFile(join(PUBLIC, file)));
        }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'Could not read local data. Check the app terminal and data/snapshot.json.' });
      else res.end();
    }
  });
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8787);
  const app = createApp();
  app.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another local port.` : 'Could not start Cadence.');
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => console.log(`Cadence is running at http://127.0.0.1:${app.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit()));
}
