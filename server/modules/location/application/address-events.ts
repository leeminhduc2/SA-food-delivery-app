import type { DeliveryAddress } from './address.service.js';

export type SavedDeliveryAddress = DeliveryAddress & { id: string; userId: string };

type Listener = (address: SavedDeliveryAddress) => Promise<void>;

let listener: Listener | null = null;

/**
 * Catalog registers a prefetch listener at composition time. Location owns the
 * save event but must not depend on restaurant concepts itself.
 */
export function setAddressSavedListener(next: Listener): void {
  listener = next;
}

/**
 * Awaited deliberately: callers expect the freshly saved address to already
 * have its quote snapshots. A failing listener must not fail the save.
 */
export async function emitAddressSaved(address: SavedDeliveryAddress): Promise<void> {
  if (!listener) return;
  try {
    await listener(address);
  } catch (error) {
    console.error('Delivery quote prefetch failed', error);
  }
}
