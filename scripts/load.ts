export {};
const base = process.env.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const parallel = Number(process.env.LOAD_CONCURRENCY || 20),
  requests = Number(process.env.LOAD_REQUESTS || 200);
let next = 0,
  errors = 0;
const durations: number[] = [];
const start = performance.now();
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next++ < requests) {
      const t = performance.now();
      try {
        const r = await fetch(base + '/api/restaurants?q=');
        if (!r.ok) errors++;
        await r.arrayBuffer();
      } catch {
        errors++;
      }
      durations.push(performance.now() - t);
    }
  }),
);
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      requests: durations.length,
      concurrency: parallel,
      errors,
      elapsedMs: Math.round(performance.now() - start),
      p95Ms: Math.round(durations[Math.floor(durations.length * 0.95)]),
      p99Ms: Math.round(durations[Math.floor(durations.length * 0.99)]),
    },
    null,
    2,
  ),
);
if (errors) process.exitCode = 1;
