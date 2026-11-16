import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { emptySnapshot } from '../public/shared/model.mjs';

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
export async function saveSnapshot(snapshot, directory = dataDir) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `snapshot.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'snapshot.json'));
  await chmod(join(directory, 'snapshot.json'), 0o600);
}

export * from '../public/shared/model.mjs';
