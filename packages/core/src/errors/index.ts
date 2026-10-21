import { envelope, type Envelope } from "@opi/contracts"

/**
 * Stable, safe error codes.
 *
 * The code is the contract. The message is for a person. Neither may leak an
 * absolute path, a stack, a SQL fragment or a provider's raw error text.
 */
export const ERROR_CODES = [
  "not_found",
  "invalid_input",
  "conflict",
  "unavailable",
  "unsupported",
  "permission_denied",
  "timeout",
  "cancelled",
  "internal",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ServiceError {
  readonly code: ErrorCode
  /** A message safe to show a user or a model. */
  readonly message: string
  /** Whether retrying the same operation could succeed. */
  readonly retryable: boolean
  /** Extra context. Keys and values must both be safe to expose. */
  readonly details?: Readonly<Record<string, string>>
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["unavailable", "timeout", "conflict"])

export class OpiError extends Error implements ServiceError {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, string>>

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, string> } = {},
  ) {
    super(message)
    this.name = "OpiError"
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE.has(code)
    if (options.details) this.details = options.details
  }
}

export function isServiceError(value: unknown): value is ServiceError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  )
}

/**
 * Convert anything thrown into a safe error.
 *
 * An unrecognised error becomes `internal` with a fixed message. The original
 * is deliberately not exposed — it goes to local logs instead.
 */
export function toServiceError(error: unknown): ServiceError {
  if (isServiceError(error)) {
    return {
      code: error.code as ErrorCode,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    }
  }
  if (error instanceof OpiError) {
    return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) }
  }
  if (error instanceof Error) {
    // A well-known, safe message is fine; anything else is not.
    if (/^(not found|invalid|unsupported|permission denied|timed out|cancelled)/i.test(error.message)) {
      return { code: "internal", message: "The operation failed.", retryable: false }
    }
  }
  return { code: "internal", message: "An internal error occurred.", retryable: false }
}

/** The original error, for local logs only. Never sent to a model. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** Wrap a service failure in the standard envelope. */
export function errorEnvelope(
  error: unknown,
  context: { projectId: string; worktreeId?: string; warnings?: string[] },
): Envelope<never> {
  const safe = toServiceError(error)
  return envelope<never>({
    status: "error",
    projectId: context.projectId,
    ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
    warnings: [...(context.warnings ?? []), `${safe.code}: ${safe.message}`],
  })
}
