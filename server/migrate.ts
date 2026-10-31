import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

/**
 * Apply the checked-in Prisma migrations with `prisma migrate deploy`.
 *
 * Deploy only runs migrations recorded in `prisma/migrations`; it never
 * generates migrations, resets the database, or pushes `schema.prisma`
 * directly. A non-zero exit rejects so startup can abort before serving.
 */
export async function migrate(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`prisma migrate deploy failed (exit ${code ?? 'null'}):\n${output.trim()}`),
        );
    });
  });
}
if (process.argv[1]?.endsWith('migrate.ts')) {
  await migrate();
  console.log('Prisma migrations applied');
}
