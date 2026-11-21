import { dateChunks, isoDay, shiftDay, validDay, normalizeActivity, normalizeDaily, normalizeSleep, normalizeHrv,
  normalizeActivityDetails, normalizeAthlete, normalizeScheduledWorkout, normalizeWorkout, mergeRecords } from './model.mjs';

const API = 'https://personal.connectapi.garmin.com';
// Bump when normalizeActivity keeps new fields, so the next sync re-downloads older activities once.
export const ACTIVITY_FIELDS = 2;
// Activity details cost one request each; they are fetched once per activity and spread over syncs.
export const DETAILS_PER_SYNC = 150;
// Scheduled workouts are read from a week ago to this many days ahead; each workout's steps cost one request.
export const PLAN_DAYS = 56;
const PLAN_WORKOUTS = 40;
export function calendarMonths(from, to) {
  const months = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shiftDay(`${month}-28`, 7).slice(0, 7)) months.push(month);
  return months;
}
const DETAIL_INTERVALS =/^(INTERVAL_|WORKOUT_ROUND|RUN_ACTIVE|RUN_REST)/;
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
    // Workers reject fetch called as a method of another object ("Illegal invocation"), so never bind it to this client.
    this.key = key; this.fetch = (...args) => fetchImpl(...args); this.signal = signal; this.onProgress = onProgress;
    this.accessToken = null;
  }
  async request(path, options = {}, attempt = 0) {
    if (this.signal?.aborted) throw this.signal.reason;
    const { responseFormat = 'json', ...fetchOptions } = options;
    let response;
    try {
      // Workers support only follow/manual redirects; never follow one with a credential attached.
      response = await this.fetch(API + path, { ...fetchOptions, redirect: 'manual',
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', ...options.headers } });
    } catch (e) {
      if (this.signal?.aborted) throw this.signal.reason;
      if (e instanceof GarminError) throw e;
      throw new GarminError('Could not reach Garmin. Check your connection and try again.');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new GarminError('Garmin redirected the request unexpectedly. Try again later.');
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
function unionRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.filter(([s, e]) => s <= e).sort((a, b) => a[0].localeCompare(b[0]))) {
    const last = merged.at(-1);
    if (last && start <= shiftDay(last[1], 1)) { if (end > last[1]) last[1] = end; }
    else merged.push([start, end]);
  }
  return merged;
}
const SOURCES = ['activities', 'daily', 'sleep', 'hrv'];
// Decides which date windows each source needs. Saved history is reused; only new days, the last saved week,
// days before the saved history, and windows that failed last time are downloaded.
export function syncPlan(previous, { requestedFrom, now, full = false }) {
  const everything = Object.fromEntries(SOURCES.map(source => [source, [[requestedFrom, now]]]));
  if (full || !previous?.requestedTo || !previous.completedAt) return { coveredFrom: requestedFrom, windows: everything };
  // A gap between the last sync and this range means older history is no longer continuous.
  const continuous = previous.requestedTo >= shiftDay(requestedFrom, -1);
  const savedFrom = previous.coveredFrom || previous.requestedFrom;
  const coveredFrom = continuous ? [savedFrom, requestedFrom].sort()[0] : requestedFrom;
  // Re-fetch the last saved week: late uploads and reprocessed sleep change recent days.
  const recent = [[requestedFrom, shiftDay(previous.requestedTo, -6)].sort().at(-1), now];
  const older = continuous ? [requestedFrom, [shiftDay(savedFrom, -1), now].sort()[0]] : [requestedFrom, now];
  const windows = Object.fromEntries(SOURCES.map(source => {
    const failed = (previous.warnings || []).filter(w => w.source === source && validDay(w.startDate) && validDay(w.endDate))
      .map(w => [[w.startDate, requestedFrom].sort().at(-1), [w.endDate, now].sort()[0]]);
    return [source, unionRanges([recent, older, ...failed])];
  }));
  // History saved before newer activity fields were kept is re-downloaded once.
  if (!(previous.activityFields >= ACTIVITY_FIELDS)) windows.activities = [[requestedFrom, now]];
  return { coveredFrom, windows };
}
export async function syncGarmin(snapshot, key, { days = 90, full = false, now = isoDay(),
  fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const requestedFrom = shiftDay(now, 1 - days);
  const { coveredFrom, windows } = syncPlan(snapshot.sync, { requestedFrom, now, full });
  const starts = Object.values(windows).flat().map(([start]) => start).sort();
  const result = structuredClone(snapshot);
  const attempt = { attemptedAt: new Date().toISOString(), requestedFrom, requestedTo: now, coveredFrom,
    fetchedFrom: starts[0] || now, fetchedTo: now, activityFields: ACTIVITY_FIELDS, fullySuccessful: false, warnings: [], coverage: [] };
  const client = new GarminClient(key, { fetchImpl, signal, onProgress });
  try {
    onProgress({ message: 'Connecting to Garmin…' });
    await client.authenticate();
    let completed = 0;
    const sources = [
      { name: 'daily', label: 'daily health', path: '/usersummary-service/v2/dailysummaries', property: 'data', normalize: normalizeDaily },
      { name: 'sleep', label: 'sleep', path: '/sleep-service/sleep/dailySleepSummariesByDate', property: null, normalize: normalizeSleep },
      { name: 'hrv', label: 'HRV', path: null, property: 'hrvSummaries', normalize: normalizeHrv },
    ].map(source => ({ ...source, chunks: windows[source.name].flatMap(([start, end]) => dateChunks(start, end)) }));
    // Details for activities in the requested range that have none yet, newest first.
    const pending = () => result.activities.filter(a => a.date >= requestedFrom && !a.detailsVersion)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, DETAILS_PER_SYNC);
    let total = windows.activities.length + sources.reduce((sum, source) => sum + source.chunks.length, 0) + 3;
    const progress = (message) => onProgress({ message, completed, total });
    const recordFailure = (source, startDate, endDate, error) => {
      if (signal?.aborted) throw signal.reason;
      // Authentication failure is not a missing metric; stop instead of sending more unauthorized requests.
      if (error.status === 401 || error.fatal) throw error;
      attempt.warnings.push({ source, startDate, endDate, message: error.message, status: error.status || 502 });
    };
    for (const [from, to] of windows.activities) {
      progress(`Downloading activities · ${from} to ${to}`);
      try {
        let records = [], offset = 0;
        const limit = 100;
        for (;;) {
          const page = arrayResponse(await client.get('/activitylist-service/activities/search/activities', {
            start: offset, limit, startDate: from, endDate: to, sortOrder: 'desc', excludeChildren: true,
          }), null, 'activity');
          records.push(...page.map(normalizeActivity).filter(Boolean));
          if (page.length < limit) break;
          offset += page.length;
          if (offset >= 10000) throw new GarminError('Activity history exceeded the sync limit. Choose a shorter range.');
          await pause(120, signal);
        }
        result.activities = mergeRecords(result.activities, records, 'id');
        attempt.coverage.push({ source: 'activities', startDate: from, endDate: to, records: records.length });
      } catch (e) { recordFailure('activities', from, to, e); }
      completed++;
    }
    for (const source of sources) {
      for (const [startDate, endDate] of source.chunks) {
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
    progress('Downloading training settings…');
    const athlete = {};
    for (const [name, path, query] of [['settings', '/userprofile-service/userprofile/settings', {}],
      ['zones', '/biometric-service/heartRateZones/v2', { generateDefaults: false }],
      ['weight', `/weight-service/weight/range/${shiftDay(now, -30)}/${now}`, {}]]) {
      try { athlete[name] = await client.get(path, query); attempt.coverage.push({ source: name, startDate: now, endDate: now, records: athlete[name] ? 1 : 0 }); }
      catch (e) { recordFailure(name, now, now, e); }
      completed++;
      await pause(120, signal);
    }
    // The calendar is read again on every sync: entries can be moved or removed at any time.
    const planFrom = shiftDay(now, -7), planTo = shiftDay(now, PLAN_DAYS);
    const months = calendarMonths(planFrom, planTo);
    total += months.length;
    let scheduled = [], calendarComplete = true;
    for (const month of months) {
      progress(`Downloading planned workouts · ${month}`);
      try {
        // Garmin numbers calendar months from 0.
        const data = await client.get(`/calendar-service/year/${month.slice(0, 4)}/month/${Number(month.slice(5)) - 1}`);
        scheduled.push(...arrayResponse(data, 'calendarItems', 'calendar').map(normalizeScheduledWorkout)
          .filter(w => w && w.date >= planFrom && w.date <= planTo));
      } catch (e) {
        calendarComplete = false; recordFailure('planned', `${month}-01`, `${month}-28`, e);
        // Denied or unknown for one month means the same for the others: one warning is enough.
        if ([403, 404].includes(e.status)) { completed += months.length - months.indexOf(month); break; }
      }
      completed++;
      await pause(120, signal);
    }
    const workoutIds = [...new Set(scheduled.map(w => w.workoutId).filter(Boolean))].slice(0, PLAN_WORKOUTS);
    total += workoutIds.length;
    const workoutDetails = new Map((result.planned || []).filter(w => w.workoutId && w.steps)
      .map(({ workoutId, sport, description, durationSeconds, steps }) => [workoutId, { sport, description, durationSeconds, steps }]));
    for (const id of workoutIds) {
      progress('Downloading planned workout steps…');
      try { workoutDetails.set(id, normalizeWorkout(await client.get(`/workout-service/workout/${encodeURIComponent(id)}`))); }
      catch (e) { recordFailure('planned', planFrom, planTo, e); }
      completed++;
      await pause(120, signal);
    }
    if (calendarComplete) {
      // Replaces the calendar window, keeps a year of earlier plans to compare against what was done.
      const fresh = scheduled.map(w => {
        const details = workoutDetails.get(w.workoutId);
        return details ? { ...w, ...details, sport: details.sport || w.sport } : w;
      });
      result.planned = mergeRecords((result.planned || []).filter(w => w.date < planFrom && w.date >= shiftDay(now, -365)), fresh, 'id')
        .sort((a, b) => a.date.localeCompare(b.date));
      attempt.coverage.push({ source: 'planned', startDate: planFrom, endDate: planTo, records: fresh.length });
    }
    const queue = pending();
    total += queue.length;
    for (const activity of queue) {
      progress(`Downloading activity details · ${activity.date}`);
      try {
        const details = await client.get(`/activity-service/activity/${encodeURIComponent(activity.id)}`);
        // The planned workout is a second request, so it is only asked for when Garmin recorded structured intervals.
        const structured = details?.splitSummaries?.some?.(x => DETAIL_INTERVALS.test(x?.splitType || ''));
        const workouts = structured ? await client.get(`/activity-service/activity/${encodeURIComponent(activity.id)}/workouts`) : null;
        result.activities = mergeRecords(result.activities, [{ id: activity.id, ...normalizeActivityDetails(details, workouts) }], 'id');
      } catch (e) { recordFailure('details', activity.date, activity.date, e); }
      completed++;
      await pause(120, signal);
    }
    if (queue.length) attempt.coverage.push({ source: 'details', startDate: queue.at(-1).date, endDate: queue[0].date, records: queue.length });
    const remaining = result.activities.filter(a => a.date >= requestedFrom && !a.detailsVersion).length;
    if (remaining) attempt.detailsRemaining = remaining;
    // A failed settings request keeps the values saved by an earlier sync.
    const fresh = Object.entries(normalizeAthlete(athlete, result.activities)).filter(([, v]) => v != null);
    if (fresh.length) result.athlete = { ...result.athlete, ...Object.fromEntries(fresh), updatedAt: new Date().toISOString() };
    if (!attempt.coverage.length) throw new GarminError('Garmin did not return any usable datasets. Existing data has been retained.');
    attempt.completedAt = new Date().toISOString();
    attempt.fullySuccessful = attempt.warnings.length === 0;
    result.sync = attempt;
    progress(attempt.fullySuccessful ? 'Sync complete.' : 'Sync finished with some unavailable data.');
    return result;
  } finally { client.dispose(); }
}
