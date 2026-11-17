import { GarminClient, GarminError } from '../public/shared/garmin.mjs';
import { validDay, shiftDay } from '../public/shared/model.mjs';
import { createMcpEndpoint } from './worker-mcp.mjs';

// Also written to the static assets' _headers file, which Cloudflare serves without running this Worker.
export const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin' };
function headers(extra = {}) {
  return { 'Cache-Control': 'no-store', ...securityHeaders, ...extra };
}
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
// Cloudflare's rate limiter keeps short-lived counters only. Without the binding (tests, local runs) or when the
// limiter fails, requests are allowed: throttling protects the service, it must not break it.
async function throttled(limiter, key) {
  if (!limiter) return false;
  try { return !(await limiter.limit({ key })).success; } catch { return false; }
}
const tooMany = () => json({ error: 'Too many requests. Wait a minute and try again.' }, 429, { 'Retry-After': '30' });
const json = (value, status = 200, extra) => new Response(JSON.stringify(value), { status,
  headers: headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }) });
async function readQuery(request) {
  // Bound streamed bodies too: this relay is public and accepts only small date/page queries.
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new GarminError('Request too large.', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let query;
  try { query = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GarminError('Invalid JSON.', 400); }
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new GarminError('Invalid query.', 400);
  return query;
}
function range(query) {
  const { startDate, endDate } = query;
  if (!validDay(startDate) || !validDay(endDate) || startDate > endDate || endDate > shiftDay(startDate, 30)) {
    throw new GarminError('Choose an inclusive data window of at most 31 days.', 400);
  }
  return { startDate, endDate };
}
function upstreamRoute(name, query) {
  if (name === 'activities') {
    if (!validDay(query.startDate) || !validDay(query.endDate) || query.startDate > query.endDate
      || query.endDate > shiftDay(query.startDate, 365)) throw new GarminError('Invalid activity date range.', 400);
    const start = Number(query.start ?? 0), limit = Number(query.limit ?? 100);
    if (!Number.isInteger(start) || start < 0 || start > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new GarminError('Invalid activity pagination.', 400);
    }
    return ['/activitylist-service/activities/search/activities', { start, limit, startDate: query.startDate,
      endDate: query.endDate, sortOrder: 'desc', excludeChildren: true }];
  }
  if (name === 'settings') return ['/userprofile-service/userprofile/settings', {}];
  if (name === 'zones') return ['/biometric-service/heartRateZones/v2', { generateDefaults: false }];
  if (name === 'details' || name === 'workouts') {
    if (typeof query.activityId !== 'string' || !/^\d{1,20}$/.test(query.activityId)) throw new GarminError('Invalid activity.', 400);
    return [`/activity-service/activity/${query.activityId}${name === 'workouts' ? '/workouts' : ''}`, {}];
  }
  const dates = range(query);
  if (name === 'weight') return [`/weight-service/weight/range/${dates.startDate}/${dates.endDate}`, {}];
  if (name === 'daily') return ['/usersummary-service/v2/dailysummaries', dates];
  if (name === 'sleep') return ['/sleep-service/sleep/dailySleepSummariesByDate', dates];
  if (name === 'hrv') return [`/hrv-service/hrv/daily/${dates.startDate}/${dates.endDate}`, {}];
  throw new GarminError('Unknown Garmin operation.', 404);
}
export function createWorker({ fetchImpl = fetch } = {}) {
  const mcp = createMcpEndpoint({ fetchImpl });
  return { async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/mcp') {
        // For desktop assistants and coding agents, not web pages: a browser-sent Origin is refused so no site can
        // drive this endpoint with a visitor's key. The key travels as a bearer header and is never stored.
        if (request.headers.get('Origin')) return json({ error: 'Browser requests are not allowed.' }, 403);
        const authorization = request.headers.get('Authorization') || '';
        const [scheme, key, extra] = authorization.split(' ');
        if (authorization.length > 8192 || scheme !== 'Bearer' || !key || extra !== undefined || /[\r\n]/.test(authorization)) {
          return json({ error: 'Send your Garmin Personal API key as "Authorization: Bearer <key>".' }, 401);
        }
        // Keyed by a hash of the Garmin key, so one caller cannot use up the service for everyone else.
        if (await throttled(env?.MCP_LIMIT, await sha256(key))) return tooMany();
        const response = await mcp.fetch(request, { authInfo: { token: key, clientId: 'garmin-personal-api-key', scopes: [] } });
        const secured = new Response(response.body, response);
        for (const [name, value] of Object.entries(headers())) secured.headers.set(name, value);
        return secured;
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        return json({ mode: 'cloud', storage: 'local-folder', timezone: 'Europe/Berlin' });
      }
      if (url.pathname.startsWith('/api/garmin/')) {
        // Public pages may be opened from any site. Credential-bearing relay calls must come from this app.
        if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
        const site = request.headers.get('Sec-Fetch-Site');
        if (site && !['same-origin', 'none'].includes(site)) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
        if (request.method !== 'POST') return json({ error: 'Use POST for Garmin operations.' }, 405);
        if (request.headers.get('X-Cadence-Request') !== '1' || !request.headers.get('Content-Type')?.startsWith('application/json')) {
          return json({ error: 'Invalid app request.' }, 403);
        }
        const query = await readQuery(request);
        const authorization = request.headers.get('Authorization') || '';
        const operation = url.pathname.slice('/api/garmin/'.length);
        if (authorization.length > 8192 || !authorization.startsWith(operation === 'token' ? 'ApiKey ' : 'Bearer ')
          || /[\r\n]/.test(authorization) || authorization.split(' ').length !== 2 || !authorization.split(' ')[1]) {
          return json({ error: 'Missing Garmin credential.' }, 401);
        }
        // The browser sends a new short-lived token on every sync, so visitors are told apart by IP address here.
        if (await throttled(env?.RELAY_LIMIT, request.headers.get('CF-Connecting-IP') || 'unknown')) return tooMany();
        const client = new GarminClient(null, { fetchImpl, signal: request.signal });
        try {
          if (operation === 'token') {
            const token = await client.request('/personalapitoken-service/personal-api/personal-api-key/token', {
              method: 'POST', responseFormat: 'text', headers: { Accept: '*/*', Authorization: authorization },
            }, 2);
            return new Response(token, { headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }) });
          }
          const [path, params] = upstreamRoute(operation, query);
          const suffix = new URLSearchParams(params).toString();
          // One upstream call per proxy request; the browser handles pacing and bounded retries. The body is relayed
          // as text: the browser parses and filters it, so parsing it here too would only spend Worker CPU time.
          const body = await client.request(path + (suffix ? '?' + suffix : ''), { responseFormat: 'text', headers: { Authorization: authorization } }, 2);
          return body.trim() ? new Response(body, { headers: headers({ 'Content-Type': 'application/json; charset=utf-8' }) })
            : new Response(null, { status: 204, headers: headers() });
        } finally { client.dispose(); }
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(headers())) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof GarminError) return json({ error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 502);
      return json({ error: 'The request could not be completed. No training data was saved on the server.' }, 500);
    }
  } };
}
export default createWorker();
