import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, normalizeActivity, normalizeDaily, normalizeSleep, normalizeHrv, selectData, dateChunks } from '../src/data.mjs';
import { syncGarmin, GarminClient } from '../src/garmin.mjs';
import { activity, daily, sleep, hrv, response, mockGarmin } from './fixtures.mjs';

test('normalizes documented DTOs, preserves missing values, and excludes profile/route fields', () => {
  const a = normalizeActivity(activity());
  assert.equal(a.durationSeconds, 3600); assert.equal(a.distanceMeters, 25000);
  assert.equal(a.utcStart, '2026-11-16T17:00:00Z');
  assert.equal(a.averagePower, undefined); assert.equal(a.startLatitude, undefined); assert.equal(a.userProfileId, undefined);
  assert.equal(normalizeDaily(daily()).steps, 7000);
  assert.equal(normalizeSleep(sleep()).sleepSeconds, 27000);
  assert.equal(normalizeSleep(sleep()).sleepScore, 85);
  assert.equal(normalizeHrv(hrv()).hrvMs, 55);
  assert.equal(normalizeDaily({ calendarDate: '2026-11-16', stress: { avgLevel: -1 } }).stress, null);
  assert.equal(normalizeDaily({ calendarDate: '2026-11-16' }).steps, null);
  assert.equal(normalizeDaily({ calendarDate: '2026-02-30' }), null);
  const zero = normalizeDaily({ calendarDate: '2026-11-16', movement: { steps: { value: 0 } } });
  assert.equal(zero.steps, 0);
});
test('date windows include both endpoints and handle a year boundary', () => {
  assert.deepEqual(dateChunks('2025-12-29', '2026-01-03', 3), [['2025-12-29', '2025-12-31'], ['2026-01-01', '2026-01-03']]);
});
test('sync paginates activities, merges health sources, and keeps credentials out of saved data', async () => {
  const mock = mockGarmin(url => url.pathname.includes('search/activities')
    ? response(Number(url.searchParams.get('start')) === 0 ? Array.from({ length: 100 }, (_, i) => activity(i)) : [activity(100)]) : null);
  const snapshot = await syncGarmin(emptySnapshot(), 'test-personal-key', { ...mock, days: 1, now: '2026-11-16' });
  assert.equal(snapshot.activities.length, 101); assert.equal(snapshot.health.length, 1);
  assert.equal(snapshot.health[0].sleepSeconds, 27000); assert.equal(snapshot.health[0].restingHeartRate, 52);
  assert.equal(snapshot.health[0].hrvMs, 55); assert.equal(snapshot.sync.fullySuccessful, true);
  assert.equal(mock.calls[0].options.headers.Authorization, 'ApiKey test-personal-key');
  assert.equal(mock.calls[0].options.headers.Accept, '*/*');
  assert.equal(mock.calls[1].options.headers.Authorization, 'Bearer test-access-token');
  assert.equal(mock.calls[1].options.headers.Accept, 'application/json');
  const calls = mock.calls.filter(c => c.url.pathname.includes('search/activities'));
  assert.equal(calls[1].url.searchParams.get('start'), '100');
  assert.equal(calls[0].url.searchParams.get('startDate'), '2026-11-16');
  assert.doesNotMatch(JSON.stringify(snapshot), /test-personal-key|test-access-token|startLatitude|userProfileId/);
});
test('repeat sync updates records without duplicates and incrementally re-fetches the last week', async () => {
  const mock = mockGarmin();
  let snapshot = await syncGarmin(emptySnapshot(), 'test-key', { ...mock, days: 30, now: '2026-11-16' });
  snapshot = await syncGarmin(snapshot, 'test-key', { ...mock, days: 30, now: '2026-11-17' });
  assert.equal(snapshot.activities.length, 1); assert.equal(snapshot.health.length, 1);
  assert.equal(snapshot.sync.fetchedFrom, '2026-11-10');
  const full = await syncGarmin(snapshot, 'test-key', { ...mock, days: 30, full: true, now: '2026-11-17' });
  assert.equal(full.sync.fetchedFrom, '2026-10-19');
});
test('partial failures retain prior measurements and expose source-specific warnings', async () => {
  const mock = mockGarmin(url => url.pathname.includes('dailySleepSummariesByDate') ? response({ error: 'secret-token-from-upstream' }, 503) : null);
  const existing = emptySnapshot(); existing.health = [{ date: '2026-11-16', sleepSeconds: 28000 }];
  const snapshot = await syncGarmin(existing, 'test-key', { ...mock, days: 1, now: '2026-11-16' });
  assert.equal(snapshot.health[0].sleepSeconds, 28000); assert.equal(snapshot.health[0].hrvMs, 55);
  assert.equal(snapshot.sync.fullySuccessful, false); assert.equal(snapshot.sync.warnings[0].source, 'sleep');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-token-from-upstream/);
  assert.deepEqual(existing.health, [{ date: '2026-11-16', sleepSeconds: 28000 }]);
});
test('unexpected dataset shapes produce warnings instead of silently recording a successful empty sync', async () => {
  const mock = mockGarmin(url => url.pathname.includes('dailysummaries') ? response({ unexpected: [] }) : null);
  const snapshot = await syncGarmin(emptySnapshot(), 'test-key', { ...mock, days: 1, now: '2026-11-16' });
  assert.equal(snapshot.sync.fullySuccessful, false); assert.equal(snapshot.sync.warnings[0].source, 'daily');
  assert.ok(!snapshot.sync.coverage.some(c => c.source === 'daily'));
});
test('empty HRV responses mean no recorded data; recent measurements still sync', async () => {
  const mock = mockGarmin(url => url.pathname.includes('/hrv/daily/') && url.pathname.endsWith('/2026-11-15')
    ? new Response(null, { status: 204 }) : null);
  const snapshot = await syncGarmin(emptySnapshot(), 'test-key', { ...mock, days: 15, now: '2026-11-16' });
  assert.equal(snapshot.sync.fullySuccessful, true);
  assert.equal(snapshot.sync.warnings.length, 0);
  const coverage = snapshot.sync.coverage.filter(c => c.source === 'hrv');
  assert.equal(coverage[0].records, 0); assert.equal(coverage[1].records, 1);
  assert.equal(snapshot.health.find(d => d.date === '2026-11-16').hrvMs, 55);
});
test('empty successful responses are distinct from malformed nonempty JSON', async () => {
  const mock = mockGarmin(url => {
    if (url.pathname === '/empty') return new Response('', { status: 200 });
    if (url.pathname === '/malformed') return new Response('<html>not data</html>', { status: 200 });
  });
  const client = new GarminClient('test-key', mock);
  await client.authenticate();
  assert.equal(await client.get('/empty'), null);
  await assert.rejects(client.get('/malformed'), /unexpected response format/);
  client.dispose();
});
test('failed authentication stops sync without mutating existing history or disclosing errors', async () => {
  const mock = mockGarmin(() => response({ token: 'sensitive-error' }, 401));
  const original = emptySnapshot();
  await assert.rejects(syncGarmin(original, 'private-test-key', { ...mock, days: 1 }), /expired or been revoked/);
  assert.equal(mock.calls.length, 1); assert.deepEqual(original, emptySnapshot());
});
test('429 uses a bounded retry and an expired access token is regenerated once', async () => {
  let tokens = 0, gets = 0;
  const mock = mockGarmin(url => {
    if (url.pathname.endsWith('/personal-api-key/token')) { tokens++; return tokens === 1 ? response({}, 429, { 'retry-after': '0' }) : new Response('fresh-token'); }
    if (url.pathname === '/test') { gets++; return gets === 1 ? response({}, 401) : response({ ok: true }); }
  });
  const client = new GarminClient('test-key', mock);
  await client.authenticate(); assert.deepEqual(await client.get('/test'), { ok: true });
  assert.equal(tokens, 3); assert.equal(gets, 2); client.dispose(); assert.equal(client.key, null); assert.equal(client.accessToken, null);
});
test('exports use only measured health days and filter activities by date', () => {
  const snapshot = emptySnapshot(); snapshot.activities = [normalizeActivity(activity()), normalizeActivity(activity(2, '2026-09-01'))];
  snapshot.health = [{ date: '2026-11-16', hrvMs: 55 }, { date: '2026-11-15', hrvMs: null }, { date: '2026-11-14', hrvMs: 45 }];
  const exportData = selectData(snapshot, 7, '2026-11-16');
  assert.equal(exportData.activities.length, 1); assert.equal(exportData.summary.averageHrvMs, 50);
  assert.equal(exportData.summary.measuredDays.hrv, 2); assert.equal(exportData.summary.averageSleepSeconds, null);
});
