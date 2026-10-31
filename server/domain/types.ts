export const roles = ['CUSTOMER', 'RESTAURANT', 'DRIVER', 'ADMIN'] as const;
export type Role = (typeof roles)[number];

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
};

/** Minimal database capability the business layers may rely on. */
export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
