/** Errors carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'غير مصرح') =>
  new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'ليست لديك صلاحية لهذه العملية') =>
  new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'غير موجود') =>
  new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) =>
  new AppError(409, 'conflict', msg, details);
export const unprocessable = (msg: string, details?: unknown) =>
  new AppError(422, 'unprocessable', msg, details);
export const tooManyRequests = (msg = 'محاولات كثيرة، حاول لاحقاً') =>
  new AppError(429, 'too_many_requests', msg);
