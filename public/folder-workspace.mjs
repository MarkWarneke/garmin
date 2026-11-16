import { emptySnapshot, selectData, briefing } from './shared/model.mjs';
import { syncGarmin, GarminError } from './shared/garmin.mjs';

const FILE = 'snapshot.json';
async function fingerprint(file) {
  const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function readFolder(directory) {
  let file;
  try { file = await (await directory.getFileHandle(FILE)).getFile(); }
  catch (error) { if (error.name === 'NotFoundError') return { snapshot: emptySnapshot(), revision: null }; throw error; }
  let snapshot;
  try { snapshot = JSON.parse(await file.text()); }
  catch { throw new Error('The selected snapshot.json is not valid JSON. Your file has not been changed.'); }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.activities) || !Array.isArray(snapshot.health)
    || snapshot.activities.some(a => !a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.sport !== 'string')
    || snapshot.health.some(d => !d || typeof d.date !== 'string')) {
    throw new Error('The selected folder contains an unsupported snapshot. Choose your Cadence data folder.');
  }
  return { snapshot, revision: await fingerprint(file) };
}
export async function writeFolder(directory, snapshot, expectedRevision) {
  // Detect a write by another browser or the local app instead of overwriting its history.
  const current = await readFolder(directory);
  if (current.revision !== expectedRevision) throw new Error('The data file changed while syncing. Reload your saved data and retry. No file was overwritten.');
  const handle = await directory.getFileHandle(FILE, { create: true });
  const writable = await handle.createWritable({ mode: 'exclusive' });
  try { await writable.write(JSON.stringify(snapshot, null, 2) + '\n'); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
}
async function rememberedHandle(value) {
  // IndexedDB holds only a directory permission handle, never Garmin keys or training records.
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cadence-folder-handle', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('handles', value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('handles');
      const operation = value === undefined ? store.get('workspace') : value === null ? store.delete('workspace') : store.put(value, 'workspace');
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
export function createProxyFetch(fetchImpl = fetch) {
  return async (uri, options = {}) => {
    const url = new URL(uri);
    if (url.origin !== 'https://personal.connectapi.garmin.com') throw new GarminError('Unsupported Garmin host.', 400);
    const routes = {
      '/personalapitoken-service/personal-api/personal-api-key/token': 'token',
      '/activitylist-service/activities/search/activities': 'activities',
      '/usersummary-service/v2/dailysummaries': 'daily',
      '/sleep-service/sleep/dailySleepSummariesByDate': 'sleep',
    };
    let operation = routes[url.pathname], query = Object.fromEntries(url.searchParams);
    const hrv = url.pathname.match(/^\/hrv-service\/hrv\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
    if (hrv) { operation = 'hrv'; query = { startDate: hrv[1], endDate: hrv[2] }; }
    if (!operation) throw new GarminError('Unsupported Garmin operation.', 400);
    let response;
    try {
      response = await fetchImpl(`/api/garmin/${operation}`, { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal: options.signal,
        headers: { 'Content-Type': 'application/json', 'X-Cadence-Request': '1', Authorization: options.headers.Authorization },
        body: JSON.stringify(query) });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = new GarminError('Could not reach your Cloudflare app. Check your connection and sign in again if your session expired.', 503);
      failure.fatal = true; throw failure;
    }
    if (response.headers.get('X-Cadence-Error')?.startsWith('ACCESS_')) {
      const failure = new GarminError('Sign in to your Cloudflare Access application, then reload Cadence and try again.', 503);
      failure.fatal = true; throw failure;
    }
    return response;
  };
}
export class FolderWorkspace {
  constructor({ fetchImpl = fetch, picker = globalThis.showDirectoryPicker } = {}) {
    this.fetchImpl = fetchImpl; this.picker = picker; this.directory = null; this.connected = false;
  }
  get supported() { return typeof this.picker === 'function'; }
  get name() { return this.connected ? this.directory.name : null; }
  async restore() {
    if (!this.supported) return;
    try {
      const handle = await rememberedHandle();
      if (handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
        await readFolder(handle); this.directory = handle; this.connected = true;
      }
    } catch { /* A fresh explicit folder selection is always available. */ }
  }
  async choose() {
    if (!this.supported) throw new Error('Use Chrome or Edge to open a local data folder.');
    // Called directly from a button click so the browser can ask for folder permission.
    const directory = await this.picker.call(globalThis, { id: 'cadence-data', mode: 'readwrite', startIn: 'documents' });
    await readFolder(directory);
    this.directory = directory; this.connected = true;
    await rememberedHandle(directory).catch(() => {});
  }
  async forget() { this.directory = null; this.connected = false; await rememberedHandle(null).catch(() => {}); }
  async snapshot() { return this.connected ? (await readFolder(this.directory)).snapshot : emptySnapshot(); }
  async data(days) { return selectData(await this.snapshot(), days); }
  async briefing(days) { return { text: briefing(await this.data(days)) }; }
  async sync(key, options) {
    if (!this.connected) throw new Error('Choose your local data folder before syncing Garmin.');
    if (await this.directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Reconnect your data folder to allow saving.');
    const { snapshot, revision } = await readFolder(this.directory);
    const result = await syncGarmin(snapshot, key, { ...options, fetchImpl: createProxyFetch(this.fetchImpl) });
    if (options.signal?.aborted) throw options.signal.reason;
    await writeFolder(this.directory, result, revision);
    return result;
  }
}
