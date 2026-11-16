import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createWorker, verifyAccess } from '../src/worker.mjs';
import { emptySnapshot } from '../src/data.mjs';
import { mockGarmin } from './fixtures.mjs';
import { FolderWorkspace, readFolder, writeFolder } from '../public/folder-workspace.mjs';

const base = 'https://cadence.example';
function request(path, data = {}, extra = {}) {
  return new Request(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json',
    'X-Cadence-Request': '1', Authorization: path.endsWith('/token') ? 'ApiKey test-personal-key' : 'Bearer test-access-token', ...extra }, body: JSON.stringify(data) });
}
function memoryFolder(initial) {
  let contents = initial;
  return { name: 'test-training', queryPermission: async () => 'granted', get contents() { return contents; },
    replace(value) { contents = value; },
    async getFileHandle(name, { create } = {}) {
      assert.equal(name, 'snapshot.json');
      if (contents === undefined && !create) throw new DOMException('Missing', 'NotFoundError');
      if (contents === undefined) contents = '';
      return { getFile: async () => new File([contents], name), async createWritable(options) {
        assert.equal(options.mode, 'exclusive'); let pending;
        return { async write(value) { pending = value; }, async close() { contents = pending; }, async abort() {} };
      } };
    },
  };
}
test('cloud deployment denies access without configuration or a valid Access session', async () => {
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request(base), {})).status, 503);
  assert.equal((await worker.fetch(new Request(base), { CADENCE_LOCAL_DEV: '1' })).status, 503);
  const env = { ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'app-audience' };
  assert.equal((await worker.fetch(new Request(base), env)).status, 401);
});
test('Access verifies the signature, issuer, audience, and expiration', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const env = { ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'app-audience' };
  const token = await new SignJWT({ email: 'test@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://example.cloudflareaccess.com').setAudience('app-audience').setExpirationTime('2m').sign(privateKey);
  const req = new Request(base, { headers: { 'Cf-Access-Jwt-Assertion': token } });
  await verifyAccess(req, env, keySet);
  await assert.rejects(verifyAccess(req, { ...env, ACCESS_AUD: 'wrong-audience' }, keySet), /invalid or expired/);
  const expired = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://example.cloudflareaccess.com')
    .setAudience('app-audience').setExpirationTime(1).sign(privateKey);
  await assert.rejects(verifyAccess(new Request(base, { headers: { 'Cf-Access-Jwt-Assertion': expired } }), env, keySet), /invalid or expired/);
  await assert.rejects(verifyAccess(new Request(base, { headers: { 'Cf-Access-Jwt-Assertion': token.slice(0, -10) + 'invalid' } }), env, keySet));
});
test('Worker restricts origins, operations and dates, relays tokens as text, and never echoes upstream errors', async () => {
  const mock = mockGarmin(); const worker = createWorker({ ...mock, authenticate: async () => {} });
  assert.equal((await worker.fetch(request('/api/garmin/token', {}, { Origin: 'https://foreign.example' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/garmin/token', {}, { 'X-Cadence-Request': '' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/garmin/daily', { startDate: '2026-01-01', endDate: '2026-11-16' }), {})).status, 400);
  assert.equal(mock.calls.length, 0);
  const token = await worker.fetch(request('/api/garmin/token'), {});
  assert.equal(await token.text(), 'test-access-token'); assert.equal(token.headers.get('cache-control'), 'no-store');
  const daily = await worker.fetch(request('/api/garmin/daily', { startDate: '2026-11-16', endDate: '2026-11-16' }), {});
  assert.equal(daily.status, 200); assert.equal((await daily.json()).data.length, 1);
  const failed = createWorker({ authenticate: async () => {}, fetchImpl: async () => new Response('private-upstream-error-with-token', { status: 401 }) });
  const error = await failed.fetch(request('/api/garmin/token'), {});
  assert.equal(error.status, 401); assert.doesNotMatch(await error.text(), /private-upstream-error-with-token|test-personal-key/);
});
test('hosted sync saves only normalized history to the selected folder, and a new browser session reads it without a key', async () => {
  const mock = mockGarmin(), worker = createWorker({ ...mock, authenticate: async () => {} });
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
test('malformed folder data is not silently overwritten', async () => {
  const directory = memoryFolder('{invalid');
  await assert.rejects(readFolder(directory), /not valid JSON/);
  assert.equal(directory.contents, '{invalid');
});
