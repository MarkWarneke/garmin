import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GarminClient, GarminError } from '../public/shared/garmin.mjs';
import { validDay, shiftDay } from '../public/shared/model.mjs';

const keySets = new Map();
export async function verifyAccess(request, env, keySetOverride) {
  const url = new URL(request.url);
  // This flag cannot bypass authentication on an Internet hostname.
  if (env.CADENCE_LOCAL_DEV === '1' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;
  const team = env.ACCESS_TEAM_DOMAIN || '';
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !env.ACCESS_AUD) {
    const error = new Error('Configure Cloudflare Access and the ACCESS_TEAM_DOMAIN / ACCESS_AUD variables before using this deployment.');
    error.status = 503; error.code = 'ACCESS_NOT_CONFIGURED'; throw error;
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) { const error = new Error('Sign in through Cloudflare Access to use Cadence.'); error.status = 401; error.code = 'ACCESS_REQUIRED'; throw error; }
  try {
    const issuer = `https://${team}`;
    if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    await jwtVerify(token, keySetOverride || keySets.get(issuer), { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
  } catch {
    const error = new Error('Your Cloudflare Access session is invalid or expired. Sign in again.');
    error.status = 401; error.code = 'ACCESS_REQUIRED'; throw error;
  }
}
function headers(extra = {}) {
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Resource-Policy': 'same-origin', ...extra };
}
const json = (value, status = 200, extra) => new Response(JSON.stringify(value), { status,
  headers: headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }) });
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
  const dates = range(query);
  if (name === 'daily') return ['/usersummary-service/v2/dailysummaries', dates];
  if (name === 'sleep') return ['/sleep-service/sleep/dailySleepSummariesByDate', dates];
  if (name === 'hrv') return [`/hrv-service/hrv/daily/${dates.startDate}/${dates.endDate}`, {}];
  throw new GarminError('Unknown Garmin operation.', 404);
}
export function createWorker({ fetchImpl = fetch, authenticate = verifyAccess } = {}) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await authenticate(request, env);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
      const site = request.headers.get('Sec-Fetch-Site');
      if (site && !['same-origin', 'none'].includes(site)) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        return json({ mode: 'cloud', storage: 'local-folder', timezone: 'Europe/Berlin' });
      }
      if (url.pathname.startsWith('/api/garmin/')) {
        if (request.method !== 'POST') return json({ error: 'Use POST for Garmin operations.' }, 405);
        if (request.headers.get('X-Cadence-Request') !== '1' || !request.headers.get('Content-Type')?.startsWith('application/json')) {
          return json({ error: 'Invalid app request.' }, 403);
        }
        const body = await request.text();
        if (body.length > 4096) return json({ error: 'Request too large.' }, 413);
        let query;
        try { query = JSON.parse(body); } catch { return json({ error: 'Invalid JSON.' }, 400); }
        if (!query || typeof query !== 'object' || Array.isArray(query)) return json({ error: 'Invalid query.' }, 400);
        const authorization = request.headers.get('Authorization') || '';
        const operation = url.pathname.slice('/api/garmin/'.length);
        if (authorization.length > 8192 || !authorization.startsWith(operation === 'token' ? 'ApiKey ' : 'Bearer ')
          || /[\r\n]/.test(authorization) || authorization.split(' ').length !== 2 || !authorization.split(' ')[1]) {
          return json({ error: 'Missing Garmin credential.' }, 401);
        }
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
          // One upstream call per proxy request; the browser handles pacing and bounded retries.
          const value = await client.request(path + (suffix ? '?' + suffix : ''), { headers: { Authorization: authorization } }, 2);
          return value == null ? new Response(null, { status: 204, headers: headers() }) : json(value);
        } finally { client.dispose(); }
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(headers())) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error.code?.startsWith('ACCESS_')) return json({ error: error.message }, error.status, { 'X-Cadence-Error': error.code });
      if (error instanceof GarminError) return json({ error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 502);
      return json({ error: 'The request could not be completed. No training data was saved on the server.' }, 500);
    }
  } };
}
export default createWorker();
