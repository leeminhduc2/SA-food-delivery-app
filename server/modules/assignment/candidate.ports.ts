import type { DB } from '../../shared/db.js';
export type CandidateLocation = {
  driverId: string;
  latitude: number;
  longitude: number;
  capturedAt: Date;
  receivedAt: Date;
};
export type CandidateSources = {
  locations: (db: DB) => Promise<CandidateLocation[]>;
  activeDrivers: (ids: readonly string[], db: DB) => Promise<string[]>;
  busyDrivers: (ids: readonly string[], db: DB) => Promise<string[]>;
};
let sources: CandidateSources | undefined;
export function setCandidateSources(value: CandidateSources): void {
  sources = value;
}
export function candidateSources(): CandidateSources {
  if (!sources) throw new Error('Candidate sources not configured');
  return sources;
}
