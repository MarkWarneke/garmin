import { dateChunks, isoDay, shiftDay, normalizeActivity, normalizeDaily, normalizeSleep, normalizeHrv,
  mergeRecords } from './data.mjs';

const API = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
export class GarminError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});
export class GarminClient {
  constructor(key, { fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
    this.key = key; this.fetch = fetchImpl; this.signal = signal; this.onProgress = onProgress;
    this.accessToken = null;
  }
  async request(path, options = {}, attempt = 0) {
    if (this.signal?.aborted) throw this.signal.reason;
    const { responseFormat = 'json', ...fetchOptions } = options;
    let response;
    try {
      response = await this.fetch(API + path, { ...fetchOptions, redirect: 'error',
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', ...options.headers } });
    } catch (e) {
      if (this.signal?.aborted) throw this.signal.reason;
      throw new GarminError('Could not reach Garmin. Check your connection and try again.');
    }
    if (response.status === 429 && attempt < 2) {
      const after = response.headers.get('retry-after');
      const delay = /^\d+$/.test(after || '') ? Number(after) * 1000 : 3000 * (attempt + 1);
      if (delay > 30000) throw new GarminError('Garmin is rate limiting requests. Try syncing again later.', 429);
      this.onProgress({ message: 'Garmin requested a pause. Retrying shortly…' });
      await pause(delay, this.signal);
      return this.request(path, options, attempt + 1);
    }
    if (!response.ok) {
      const reason = response.status === 401 ? 'Garmin rejected the credential. Check whether the personal key has expired or been revoked.'
        : response.status === 403 ? 'Garmin denied access to this data.'
        : response.status === 429 ? 'Garmin is rate limiting requests. Try syncing again later.'
        : `Garmin returned HTTP ${response.status}.`;
      // Never echo Garmin response bodies: an upstream error can contain credentials or profile data.
      throw new GarminError(reason, response.status);
    }
    try {
      const body = await response.text();
      if (responseFormat === 'text') return body;
      // The Personal API can return an empty 200/204 for periods with no measurements.
      // Garmin's official client also treats an empty response as no data, rather than invalid JSON.
      return body.trim() ? JSON.parse(body) : null;
    }
    catch { throw new GarminError('Garmin returned an unexpected response format.'); }
  }
  async authenticate() {
    // Garmin's official client uses Accept */* here: the response is a raw token, not JSON.
    const data = await this.request(TOKEN_PATH, { method: 'POST', responseFormat: 'text',
      headers: { Accept: '*/*', Authorization: `ApiKey ${this.key}` } });
    this.accessToken = data.trim();
    if (typeof this.accessToken !== 'string' || !this.accessToken) {
      throw new GarminError('Garmin did not return an access token.');
    }
  }
  async get(path, query = {}) {
    const suffix = new URLSearchParams(query).toString();
    const uri = path + (suffix ? `?${suffix}` : '');
    try { return await this.request(uri, { headers: { Authorization: `Bearer ${this.accessToken}` } }); }
    catch (e) {
      if (e.status !== 401) throw e;
      await this.authenticate();
      return this.request(uri, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    }
  }
  dispose() { this.key = null; this.accessToken = null; }
}
function arrayResponse(value, property, label) {
  if (value == null) return [];
  const rows = property ? value?.[property] : value;
  if (!Array.isArray(rows)) throw new GarminError(`Unexpected ${label} response. Existing data has been retained.`);
  return rows;
}
export async function syncGarmin(snapshot, key, { days = 90, full = false, now = isoDay(),
  fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const requestedFrom = shiftDay(now, 1 - days);
  // Re-fetch the latest week, which can include late uploads and edited/reprocessed sleep.
  const previous = snapshot.sync;
  const canIncrement = !full && previous?.fullySuccessful && previous.requestedFrom <= requestedFrom
    && previous.requestedTo >= shiftDay(now, -7);
  const from = canIncrement ? [requestedFrom, shiftDay(previous.requestedTo, -6)].sort().at(-1) : requestedFrom;
  const result = structuredClone(snapshot);
  const attempt = { attemptedAt: new Date().toISOString(), requestedFrom, requestedTo: now,
    fetchedFrom: from, fetchedTo: now, fullySuccessful: false, warnings: [], coverage: [] };
  const client = new GarminClient(key, { fetchImpl, signal, onProgress });
  try {
    onProgress({ message: 'Connecting to Garmin…' });
    await client.authenticate();
    let completed = 0;
    const chunks = dateChunks(from, now);
    const total = chunks.length * 3 + 1;
    const progress = (message) => onProgress({ message, completed, total });
    const recordFailure = (source, startDate, endDate, error) => {
      if (signal?.aborted) throw signal.reason;
      // Authentication failure is not a missing metric; stop instead of sending more unauthorized requests.
      if (error.status === 401) throw error;
      attempt.warnings.push({ source, startDate, endDate, message: error.message, status: error.status || 502 });
    };
    progress('Downloading activity history…');
    try {
      let records = [], offset = 0;
      const limit = 100;
      for (;;) {
        const page = arrayResponse(await client.get('/activitylist-service/activities/search/activities', {
          start: offset, limit, startDate: from, endDate: now, sortOrder: 'desc', excludeChildren: true,
        }), null, 'activity');
        records.push(...page.map(normalizeActivity).filter(Boolean));
        if (page.length < limit) break;
        offset += page.length;
        if (offset >= 10000) throw new GarminError('Activity history exceeded the sync limit. Choose a shorter range.');
        await pause(120, signal);
      }
      result.activities = mergeRecords(result.activities, records, 'id');
      attempt.coverage.push({ source: 'activities', startDate: from, endDate: now, records: records.length });
    } catch (e) { recordFailure('activities', from, now, e); }
    completed++;
    const sources = [
      { name: 'daily', label: 'daily health', path: '/usersummary-service/v2/dailysummaries', property: 'data', normalize: normalizeDaily },
      { name: 'sleep', label: 'sleep', path: '/sleep-service/sleep/dailySleepSummariesByDate', property: null, normalize: normalizeSleep },
      { name: 'hrv', label: 'HRV', path: null, property: 'hrvSummaries', normalize: normalizeHrv },
    ];
    for (const source of sources) {
      for (const [startDate, endDate] of chunks) {
        progress(`Downloading ${source.label} · ${startDate} to ${endDate}`);
        try {
          const data = source.path
            ? await client.get(source.path, { startDate, endDate })
            : await client.get(`/hrv-service/hrv/daily/${startDate}/${endDate}`);
          const rows = arrayResponse(data, source.property, source.label).map(source.normalize).filter(Boolean);
          result.health = mergeRecords(result.health, rows);
          attempt.coverage.push({ source: source.name, startDate, endDate, records: rows.length });
        } catch (e) { recordFailure(source.name, startDate, endDate, e); }
        completed++;
        await pause(120, signal);
      }
    }
    if (!attempt.coverage.length) throw new GarminError('Garmin did not return any usable datasets. Existing data has been retained.');
    attempt.completedAt = new Date().toISOString();
    attempt.fullySuccessful = attempt.warnings.length === 0;
    result.sync = attempt;
    progress(attempt.fullySuccessful ? 'Sync complete.' : 'Sync finished with some unavailable data.');
    return result;
  } finally { client.dispose(); }
}
