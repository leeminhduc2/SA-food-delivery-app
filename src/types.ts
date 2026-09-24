export type Actor = { id: string; name: string; email: string; role: string };
export type Line = { itemId: string; quantity: number; optionIds: string[] };
export type Basket = { items: Line[]; version: number };
export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
