import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createWorker } from '../src/worker.mjs';
import { mockGarmin, response } from './fixtures.mjs';

const base = 'https://cadence.example';
async function connect(worker, key = 'test-personal-key') {
  const client = new Client({ name: 'cadence-remote-tests', version: '1.0.0' });
  const fetch = (url, init) => worker.fetch(new Request(url, init), {});
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'),
    { fetch, requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const read = result => JSON.parse(result.content[0].text);

test('remote MCP endpoint serves live, normalized Garmin data with the caller key and stores nothing', async t => {
  const mock = mockGarmin(); const worker = createWorker(mock);
  const client = await connect(worker); t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['garmin_activities', 'garmin_activity_details', 'garmin_athlete', 'garmin_health', 'garmin_planned_workouts', 'garmin_todays_form']);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  assert.equal(mock.calls.length, 0);

  const activities = read(await client.callTool({ name: 'garmin_activities', arguments: { days: 7, endDate: '2026-11-16' } }));
  assert.deepEqual(activities.range, { startDate: '2026-11-10', endDate: '2026-11-16' });
  assert.equal(activities.activities[0].id, '1'); assert.equal(activities.hasMore, false);
  const token = mock.calls.find(call => call.url.pathname.endsWith('/token'));
  assert.equal(token.options.headers.Authorization, 'ApiKey test-personal-key');
  assert.equal(mock.calls.at(-1).options.headers.Authorization, 'Bearer test-access-token');

  const details = read(await client.callTool({ name: 'garmin_activity_details', arguments: { activityId: '1' } }));
  assert.equal(details.ftpWatts, 250); assert.equal(details.rpe, 7); assert.equal(details.plannedWorkout.name, '5x5 VO2');
  const health = read(await client.callTool({ name: 'garmin_health', arguments: { days: 1, endDate: '2026-11-16' } }));
  assert.deepEqual(health.health.map(day => [day.date, day.restingHeartRate, day.sleepScore, day.hrvMs]), [['2026-11-16', 52, 85, 55]]);
  const athlete = read(await client.callTool({ name: 'garmin_athlete', arguments: {} }));
  assert.equal(athlete.lactateThresholdHeartRate, 168); assert.equal(athlete.weightKg, 80.4);
  // Coordinates, account ids and the display name are dropped before anything reaches the assistant.
  assert.doesNotMatch(JSON.stringify([activities, details, health, athlete]), /52\.52|13\.4|1234|private-display-name|Latitude/);

  const invalid = await client.callTool({ name: 'garmin_health', arguments: { days: 90 } });
  assert.equal(invalid.isError, true);
});

test('remote MCP endpoint refuses browsers and missing keys, and reports Garmin errors without upstream bodies', async t => {
  const worker = createWorker(mockGarmin());
  const post = headers => worker.fetch(new Request(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...headers }, body: '{}' }), {});
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'ApiKey test-personal-key' })).status, 401);
  assert.equal((await post({ Authorization: 'Bearer a b' })).status, 401);
  assert.equal((await post({ Authorization: 'Bearer test-personal-key', Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post({ Authorization: 'Bearer test-personal-key', Origin: base })).status, 403);

  const rejected = createWorker(mockGarmin(url => url.pathname.endsWith('/token') ? response({ secret: 'private-upstream-error' }, 401) : null));
  const client = await connect(rejected); t.after(() => client.close());
  const result = await client.callTool({ name: 'garmin_activities', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rejected the credential/);
  assert.doesNotMatch(result.content[0].text, /private-upstream-error|test-personal-key/);
});

test('health tool keeps partial results when one Garmin source fails', async t => {
  const worker = createWorker(mockGarmin(url => url.pathname.includes('/hrv/daily/') ? response({}, 503) : null));
  const client = await connect(worker); t.after(() => client.close());
  const health = read(await client.callTool({ name: 'garmin_health', arguments: { days: 1, endDate: '2026-11-16' } }));
  assert.equal(health.health[0].sleepScore, 85); assert.equal(health.health[0].hrvMs, undefined);
  assert.deepEqual(health.warnings.map(w => w.source), ['hrv']);
});

test('remote MCP reads scheduled workouts and prepares today\'s form check from live data', async t => {
  const mock = mockGarmin(); const worker = createWorker(mock);
  const client = await connect(worker); t.after(() => client.close());
  const planned = read(await client.callTool({ name: 'garmin_planned_workouts', arguments: { days: 7, startDate: '2026-11-16' } }));
  assert.deepEqual(planned.planned.map(w => [w.date, w.name, w.durationSeconds]), [['2026-11-17', 'Tempo 3x6', 2580]]);
  assert.equal(planned.planned[0].steps[1].repeat, 3);
  const form = await client.callTool({ name: 'garmin_todays_form', arguments: {} });
  assert.match(form.content[0].text, /Please check my form today/);
  assert.match(form.content[0].text, /"health": \[/);
  assert.doesNotMatch(form.content[0].text, /test-personal-key|test-access-token/);
});
