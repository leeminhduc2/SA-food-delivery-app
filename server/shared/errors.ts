export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function check(ok: unknown, status: number, code: string, message: string): asserts ok {
  if (!ok) throw new AppError(status, code, message);
}
