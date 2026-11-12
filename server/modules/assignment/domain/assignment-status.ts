export const searchTransitions = {
  WAITING: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['WAITING', 'OFFERED', 'EXHAUSTED', 'CANCELLED'],
  OFFERED: ['SEARCHING', 'WAITING', 'ASSIGNED', 'CANCELLED'],
  ASSIGNED: [],
  EXHAUSTED: [],
  CANCELLED: [],
} as const;
export const offerTransitions = {
  OFFERED: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'REVOKED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
} as const;
export type SearchStatus = keyof typeof searchTransitions;
export type OfferStatus = keyof typeof offerTransitions;
export function canTransitionSearch(from: SearchStatus, to: SearchStatus): boolean {
  return (searchTransitions[from] as readonly SearchStatus[]).includes(to);
}
export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  return (offerTransitions[from] as readonly OfferStatus[]).includes(to);
}
