import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProofStorage } from '../delivery.ports.js';

const KEY = /^[a-f0-9]{32}$/;

/**
 * Private single-instance storage for the demo. Keys are generated here and
 * never derived from input; the directory is outside the static web root.
 * Production object storage is deferred (EXT03).
 */
export function createLocalProofStorage(directory: string): ProofStorage {
  const root = resolve(directory);
  const pathFor = (key: string) => {
    if (!KEY.test(key)) throw new Error('Invalid proof storage key.');
    return join(root, key);
  };
  return {
    newKey: () => randomBytes(16).toString('hex'),
    async put(key, bytes) {
      const target = pathFor(key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      // Write to a temporary name then rename so readers never see a partial file.
      const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(staging, bytes, { mode: 0o600, flag: 'wx' });
      await rename(staging, target);
    },
    async read(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
