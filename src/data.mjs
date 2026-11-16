import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { emptySnapshot } from '../public/shared/model.mjs';
import { emptyProfile, normalizeProfile } from '../public/shared/profile.mjs';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const dataDir = resolve(process.env.CADENCE_DATA_DIR || join(projectDir, 'data'));
export const snapshotFile = join(dataDir, 'snapshot.json');
export async function loadSnapshot(directory = dataDir) {
  try {
    const data = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.activities) || !Array.isArray(data.health)) {
      throw new Error('The local snapshot has an unsupported format. Restore a backup or move data/snapshot.json aside.');
    }
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return emptySnapshot();
    throw e;
  }
}
async function writePrivate(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `${name}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, `${name}.json`));
  await chmod(join(directory, `${name}.json`), 0o600);
}
export const saveSnapshot = (snapshot, directory = dataDir) => writePrivate(directory, 'snapshot', snapshot);
// The athlete profile lives in its own file so a Garmin sync never touches it.
export async function loadProfile(directory = dataDir) {
  try { return normalizeProfile(JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))); }
  catch (e) {
    if (e.code === 'ENOENT') return emptyProfile();
    if (e instanceof SyntaxError) throw new Error('profile.json is not valid JSON. Fix or move it aside.');
    throw e;
  }
}
export async function saveProfile(profile, directory = dataDir) {
  const saved = normalizeProfile({ ...profile, updatedAt: new Date().toISOString() });
  await writePrivate(directory, 'profile', saved);
  return saved;
}

export * from '../public/shared/model.mjs';
