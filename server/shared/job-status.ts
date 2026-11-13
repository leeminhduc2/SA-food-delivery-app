/** In-process record of background stages; durable backlog lives in each module's tables. */
type StageStatus = {
  name: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
};

const stages = new Map<string, StageStatus>();

export function recordStage(name: string, error?: unknown): void {
  const now = new Date().toISOString();
  const entry = stages.get(name) ?? {
    name,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  };
  entry.lastRunAt = now;
  if (error === undefined) {
    entry.lastSuccessAt = now;
    entry.consecutiveFailures = 0;
  } else {
    // Messages only; no stack traces, secrets or payloads.
    entry.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    entry.lastErrorAt = now;
    entry.consecutiveFailures++;
  }
  stages.set(name, entry);
}

export function stageStatuses(): StageStatus[] {
  return [...stages.values()].map((entry) => ({ ...entry }));
}
