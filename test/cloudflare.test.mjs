import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.mjs';
import { emptySnapshot } from '../src/data.mjs';
import { mockGarmin } from './fixtures.mjs';
import { FolderWorkspace, readFolder, writeFolder } from '../public/folder-workspace.mjs';

const base = 'https://cadence.example';
function request(path, data = {}, extra = {}) {
  return new Request(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json',
    'X-Cadence-Request': '1', Authorization: path.endsWith('/token') ? 'ApiKey test-personal-key' : 'Bearer test-access-token', ...extra }, body: JSON.stringify(data) });
}
function memoryFolder(initial) {
  const files = { 'snapshot.json': initial };
  return { name: 'test-training', queryPermission: async () => 'granted', files, get contents() { return files['snapshot.json']; },
    replace(value) { files['snapshot.json'] = value; },
    async getFileHandle(name, { create } = {}) {
      assert.ok(name in files || name === 'profile.json');
      if (files[name] === undefined && !create) throw new DOMException('Missing', 'NotFoundError');
      if (files[name] === undefined) files[name] = '';
      return { getFile: async () => new File([files[name]], name), async createWritable(options) {
        if (name === 'snapshot.json') assert.equal(options.mode, 'exclusive');
        let pending;
        return { async write(value) { pending = value; }, async close() { files[name] = pending; }, async abort() {} };
      } };
    },
  };
}
test('public deployment serves the app and bootstrap without a Cloudflare account or session', async () => {
  const worker = createWorker();
  const env = { ASSETS: { fetch: async () => new Response('<html>Cadence</html>', { headers: { 'Content-Type': 'text/html' } }) } };
  const page = await worker.fetch(new Request(base, { headers: {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
    Referer: 'https://chatgpt.com/',
  } }), env);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>Cadence</html>');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const bootstrap = await worker.fetch(new Request(base + '/api/bootstrap'), env);
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { mode: 'cloud', storage: 'local-folder', timezone: 'Europe/Berlin' });
  assert.equal((await worker.fetch(new Request(base + '/api/data'), env)).status, 404);
});
test('public relay keeps each visitor credential and response isolated', async () => {
  const worker = createWorker({ fetchImpl: async (_url, options) => {
    const credential = options.headers.Authorization;
    // Interleave separate visitors' requests through the same Worker instance.
    await new Promise(resolve => setTimeout(resolve, credential.endsWith('alice') ? 10 : 1));
    return new Response(credential.endsWith('alice') ? 'alice-access-token' : 'bob-access-token');
  } });
  const responses = await Promise.all(['alice', 'bob'].map(name => worker.fetch(request('/api/garmin/token', {}, { Authorization: `ApiKey ${name}` }), {})));
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['alice-access-token', 'bob-access-token']);
  assert.ok(responses.every(response => response.headers.get('cache-control') === 'no-store'));
  const missing = await worker.fetch(request('/api/garmin/token', {}, { Authorization: '' }), {});
  assert.equal(missing.status, 401);
});
test('Worker restricts origins, operations and dates, relays tokens as text, and never echoes upstream errors', async () => {
  const mock = mockGarmin(); const worker = createWorker(mock);
  assert.equal((await worker.fetch(request('/api/garmin/token', {}, { Origin: 'https://foreign.example' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/garmin/token', {}, { 'Sec-Fetch-Site': 'cross-site' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/garmin/token', {}, { 'X-Cadence-Request': '' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/garmin/token', { padding: 'x'.repeat(4096) }), {})).status, 413);
  assert.equal((await worker.fetch(request('/api/garmin/daily', { startDate: '2026-01-01', endDate: '2026-11-16' }), {})).status, 400);
  assert.equal((await worker.fetch(request('/api/garmin/arbitrary-url', { startDate: '2026-11-16', endDate: '2026-11-16', url: 'https://foreign.example' }), {})).status, 404);
  assert.equal(mock.calls.length, 0);
  const token = await worker.fetch(request('/api/garmin/token'), {});
  assert.equal(await token.text(), 'test-access-token'); assert.equal(token.headers.get('cache-control'), 'no-store');
  const daily = await worker.fetch(request('/api/garmin/daily', { startDate: '2026-11-16', endDate: '2026-11-16' }), {});
  assert.equal(daily.status, 200); assert.equal((await daily.json()).data.length, 1);
  const failed = createWorker({ fetchImpl: async () => new Response('private-upstream-error-with-token', { status: 401 }) });
  const error = await failed.fetch(request('/api/garmin/token'), {});
  assert.equal(error.status, 401); assert.doesNotMatch(await error.text(), /private-upstream-error-with-token|test-personal-key/);
});
test('hosted sync saves only normalized history to the selected folder, and a new browser session reads it without a key', async () => {
  const mock = mockGarmin(), worker = createWorker(mock);
  const requests = [];
  const fetchImpl = async (path, options) => {
    requests.push({ path, body: options.body });
    return worker.fetch(new Request(base + path, { ...options, headers: { ...options.headers, Origin: base } }), {});
  };
  const directory = memoryFolder();
  const first = new FolderWorkspace({ fetchImpl }); first.directory = directory; first.connected = true;
  const snapshot = await first.sync('test-personal-key', { days: 1, now: '2026-11-16' });
  assert.equal(snapshot.sync.fullySuccessful, true);
  assert.doesNotMatch(directory.contents, /test-personal-key|test-access-token|startLatitude|userProfileId/);
  assert.ok(requests.every(r => !r.body.includes('activities') && !r.body.includes('health') && !r.body.includes('test-personal-key')));
  const second = new FolderWorkspace({ fetchImpl: () => { throw new Error('Reading saved data must not contact the server.'); } });
  second.directory = directory; second.connected = true;
  assert.equal((await second.data(7)).range.days, 7);
  const resumed = await second.snapshot();
  assert.equal(resumed.activities.length, 1);
  assert.equal(resumed.health[0].hrvMs, 55);
});
test('local folder writes detect external edits and preserve the newer file', async () => {
  const directory = memoryFolder(JSON.stringify(emptySnapshot()));
  const { snapshot, revision } = await readFolder(directory);
  const newer = { ...emptySnapshot(), sync: { completedAt: 'newer' } };
  directory.replace(JSON.stringify(newer));
  await assert.rejects(writeFolder(directory, snapshot, revision), /changed while syncing/);
  assert.deepEqual(JSON.parse(directory.contents), newer);
});
test('the athlete profile is saved in its own file in the selected folder, separate from synced history', async () => {
  const directory = memoryFolder(JSON.stringify(emptySnapshot()));
  const workspace = new FolderWorkspace(); workspace.directory = directory; workspace.connected = true;
  assert.equal((await workspace.profile()).goal, null);
  await workspace.saveProfile({ goal: 'Gran fondo', ftpWatts: 250, prompt: null });
  assert.equal(JSON.parse(directory.files['profile.json']).ftpWatts, 250);
  assert.equal(JSON.parse(directory.contents).activities.length, 0);
  assert.equal((await workspace.profile()).goal, 'Gran fondo');
  const disconnected = new FolderWorkspace();
  await assert.rejects(disconnected.saveProfile({ goal: 'x' }), /Choose your local data folder/);
});
test('malformed folder data is not silently overwritten', async () => {
  const directory = memoryFolder('{invalid');
  await assert.rejects(readFolder(directory), /not valid JSON/);
  assert.equal(directory.contents, '{invalid');
});
test('Worker relays the training settings and activity detail operations with validated parameters', async () => {
  const mock = mockGarmin(); const worker = createWorker(mock);
  for (const [op, body] of [['settings', {}], ['zones', {}], ['weight', { startDate: '2026-10-17', endDate: '2026-11-16' }],
    ['details', { activityId: '1' }], ['workouts', { activityId: '1' }]]) {
    assert.equal((await worker.fetch(request('/api/garmin/' + op, body), {})).status, 200, op);
  }
  assert.equal((await worker.fetch(request('/api/garmin/details', { activityId: '1/../../x' }), {})).status, 400);
  assert.equal((await worker.fetch(request('/api/garmin/weight', { startDate: '2026-01-01', endDate: '2026-11-16' }), {})).status, 400);
  assert.equal(mock.calls.find(c => c.url.pathname.endsWith('heartRateZones/v2')).url.searchParams.get('generateDefaults'), 'false');
});
