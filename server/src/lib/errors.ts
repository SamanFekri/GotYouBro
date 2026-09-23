export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_FILE: 400,
  UNAUTHORIZED: 401,
  INVALID_TOKEN: 401,
  TOKEN_REVOKED: 401,
  FORBIDDEN: 403,
  USER_BLOCKED: 403,
  SERVICE_DISABLED: 403,
  LIMIT_EXCEEDED: 403,
  NOT_FOUND: 404,
  SERVICE_NOT_FOUND: 404,
  BACKUP_NOT_FOUND: 404,
  DESTINATION_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  DESTINATION_NOT_CONFIGURED: 422,
  DESTINATION_NOT_VERIFIED: 422,
  DESTINATION_VERIFICATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  TELEGRAM_DELIVERY_FAILED: 502,
  TELEGRAM_UNAVAILABLE: 503,
  NOT_READY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERROR_STATUS[code];
  }
}

export const notFound = (code: Extract<ErrorCode, `${string}NOT_FOUND`>, what: string) => new AppError(code, `${what} not found`);
