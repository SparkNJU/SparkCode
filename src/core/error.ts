// core/error.ts — 统一结构化错误

/** LLM 失败的结构化描述 */
export interface LlmFailure {
  message: string
  code: string       // 'AUTH' | 'RATE_LIMIT' | 'NO_ADAPTER' | 'UNKNOWN'
  status?: number    // HTTP 状态码
}

/** LLM 层抛出的错误 */
export class LlmError extends Error {
  readonly failure: LlmFailure

  constructor(message: string, code: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = 'LlmError'
    this.failure = {
      message,
      code,
      ...(options?.status !== undefined ? { status: options.status } : {}),
    }
  }
}

/** 错误码常量 */
export const ErrorCode = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  NO_ADAPTER: 'NO_ADAPTER',
  UNKNOWN: 'UNKNOWN',
  TOOL_FAILED: 'TOOL_FAILED',
} as const

/** 将未知错误转为结构化对象（不抛出，供上层使用） */
export function toLlmFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  if (error instanceof Error) return { message: error.message, code: ErrorCode.UNKNOWN }
  return { message: String(error), code: ErrorCode.UNKNOWN }
}
