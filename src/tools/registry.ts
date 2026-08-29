// tools/registry.ts — 工具注册表 + 统一执行管道

import type { ToolDefinition, ToolResult, ToolRunContext, ToolCallInput, ToolSchema } from './types.js'

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>()

  /** 注册工具，返回 disposer */
  register(def: ToolDefinition): () => void {
    const name = def.schema.function.name
    if (this.defs.has(name)) {
      throw new Error(`[ToolRegistry] duplicate tool: "${name}"`)
    }
    this.defs.set(name, def)
    return () => { this.defs.delete(name) }
  }

  /** 获取所有工具 schema（供 prompt 注入） */
  schemas(): ToolSchema[] {
    return [...this.defs.values()].map(d => d.schema)
  }

  /** 检查是否有工具注册 */
  hasTools(): boolean {
    return this.defs.size > 0
  }

  /** 统一执行管道 */
  async execute(
    input: ToolCallInput,
    ctx: Omit<ToolRunContext, 'callId'>,
  ): Promise<ToolResult> {
    const def = this.defs.get(input.name)
    if (!def) {
      return {
        content: `Error: unknown tool "${input.name}". Available tools: ${[...this.defs.keys()].join(', ')}`,
        isError: true,
      }
    }

    // 构造完整的 ToolRunContext
    const runCtx: ToolRunContext = {
      ...ctx,
      callId: input.id,
    }

    // 执行工具（包裹超时）
    try {
      const result = await withTimeout(
        def.execute(input.args, runCtx),
        60_000,
        runCtx.signal,
      )
      return normalizeResult(result)
    } catch (e) {
      return toolErrorResult(e)
    }
  }
}

// ─── 工具函数 ───

function normalizeResult(result: ToolResult): ToolResult {
  return {
    content: typeof result.content === 'string' ? result.content : String(result.content),
    isError: Boolean(result.isError),
    meta: result.meta,
  }
}

function toolErrorResult(error: unknown): ToolResult {
  if (error instanceof Error) {
    return {
      content: `Error: ${error.message}`,
      isError: true,
      meta: { name: error.name },
    }
  }
  return {
    content: `Error: ${String(error)}`,
    isError: true,
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${ms}ms`))
    }, ms)

    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })

    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
