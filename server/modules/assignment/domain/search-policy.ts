export type SearchLimits = Readonly<{ maxRounds: number; maxOffers: number }>;
export type SearchProgress = Readonly<{ round: number; offersCreated: number; deadlineAt: Date }>;
export type NoCandidateDecision =
  | { kind: 'EXHAUSTED'; reason: 'DEADLINE' | 'OFFER_LIMIT' | 'ROUNDS_EXHAUSTED' }
  | { kind: 'WAIT'; nextRound: number; delaySeconds: number };
export function decideNoCandidate(
  progress: SearchProgress,
  now: Date,
  limits: SearchLimits,
): NoCandidateDecision {
  if (now >= progress.deadlineAt) return { kind: 'EXHAUSTED', reason: 'DEADLINE' };
  if (progress.offersCreated >= limits.maxOffers)
    return { kind: 'EXHAUSTED', reason: 'OFFER_LIMIT' };
  if (progress.round >= limits.maxRounds) return { kind: 'EXHAUSTED', reason: 'ROUNDS_EXHAUSTED' };
  return {
    kind: 'WAIT',
    nextRound: progress.round + 1,
    delaySeconds: progress.round === 1 ? 30 : 60,
  };
}
