// tools/types.ts — 工具类型定义

import type { Agent } from '../core/loop.js'

/** 模型可见的 JSON Schema 工具描述 */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>  // JSON Schema
  }
}

/** 工具执行上下文（每个调用一份） */
export interface ToolRunContext {
  callId: string
  signal: AbortSignal          // 取消贯穿
  agent: Agent
  cwd: string                  // 当前工作目录
  deferContext(msg: string): void   // 延迟注入上下文（供下一 step 使用）
  writeEvent(type: string, data: unknown): void  // 工具自有的日志事件
}

/** 工具执行结果（统一结构，交给模型） */
export interface ToolResult {
  content: string              // 模型可见文本（可截断）
  isError: boolean
  meta?: Record<string, unknown>  // UI 呈现用，不发给模型
}

/** 工具定义 */
export interface ToolDefinition {
  schema: ToolSchema
  execute(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>
  /** 可选：结果后处理（截断/改写） */
  finalizeContent?(ctx: ToolRunContext, result: ToolResult): string | undefined
}

/** 工具调用输入（传给 registry.execute） */
export interface ToolCallInput {
  id: string                          // tool_call_id（模型生成）
  name: string                        // 工具名
  args: Record<string, unknown>       // 解析后的参数
}
