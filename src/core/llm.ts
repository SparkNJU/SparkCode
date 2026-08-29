// core/llm.ts — LLM 适配器 + 流式解析 + BlockAssembler（核心自研）

import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { LlmError, ErrorCode } from './error.js'
import type { Context } from './context.js'
import type {
  ContentBlock,
  AssistantMessage,
  TokenUsage,
  StreamChunk,
  DerivedMessage,
} from './session.js'
import { generateId } from './session.js'
import type { ToolSchema } from '../tools/types.js'

// ─── 流式 chunk 类型（复用 session.ts 中的定义） ───
export type { StreamChunk }

// ─── LLM 请求选项 ───

export interface GenerateOptions {
  model: string
  messages: ApiMessage[]
  tools?: ToolSchema[]
}

// ─── API 消息格式（OpenAI 兼容） ───

export type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// ─── ParsedToolCall ───

export interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// ─── streamModel — 流式请求（自研输出解析） ───

export async function* streamModel(
  client: OpenAI,
  request: GenerateOptions,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const hasTools = request.tools && request.tools.length > 0

  const stream = await client.chat.completions.create(
    {
      model: request.model,
      messages: request.messages as ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
      ...(hasTools ? { tools: request.tools as OpenAI.ChatCompletionTool[], tool_choice: 'auto' as const } : {}),
    },
    { signal },
  )

  for await (const part of stream) {
    // 提取 usage（在最后一个 chunk 中，无 choices）
    if (part.usage) {
      yield {
        kind: 'finish',
        reason: 'usage',
        usage: {
          promptTokens: part.usage.prompt_tokens,
          completionTokens: part.usage.completion_tokens,
          totalTokens: part.usage.total_tokens,
        },
      }
    }

    const delta = part.choices[0]?.delta
    if (!delta) continue

    // content 增量
    if (delta.content) {
      yield { kind: 'content', text: delta.content }
    }

    // tool_calls 增量（按 index 分片的 JSON 片段）
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        yield {
          kind: 'tool-call-part',
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argsFragment: tc.function?.arguments ?? '',
        }
      }
    }

    // 流结束
    if (part.choices[0]?.finish_reason) {
      yield { kind: 'finish', reason: part.choices[0].finish_reason }
    }
  }
}

// ─── BlockAssembler — 增量组装完整消息（自研核心） ───

export class BlockAssembler {
  private contentParts: string[] = []
  private toolParts = new Map<number, { id?: string; name?: string; args: string }>()
  private finishReason: string | null = null

  /** 喂入一个 chunk */
  feed(chunk: StreamChunk): void {
    switch (chunk.kind) {
      case 'content':
        this.contentParts.push(chunk.text)
        break
      case 'tool-call-part': {
        let part = this.toolParts.get(chunk.index)
        if (!part) {
          part = { args: '' }
          this.toolParts.set(chunk.index, part)
        }
        if (chunk.id) part.id = chunk.id
        if (chunk.name) part.name = chunk.name
        part.args += chunk.argsFragment
        break
      }
      case 'finish':
        this.finishReason = chunk.reason
        break
    }
  }

  /** 完成组装，返回 ContentBlock 数组 */
  finish(): { content: ContentBlock[]; finishReason: string | null } {
    const blocks: ContentBlock[] = []

    // 文本块
    if (this.contentParts.length > 0) {
      blocks.push({ type: 'text', text: this.contentParts.join('') })
    }

    // tool-call 块（按 index 排序）
    const sortedEntries = [...this.toolParts.entries()].sort((a, b) => a[0] - b[0])
    for (const [index, p] of sortedEntries) {
      blocks.push({
        type: 'tool-call',
        id: p.id ?? `call_${index}`,
        name: p.name ?? '',
        arguments: p.args,
      })
    }

    return { content: blocks, finishReason: this.finishReason }
  }

  /** 解析 tool-call（含 JSON 容错） */
  parseToolCalls(): ParsedToolCall[] {
    const { content } = this.finish()
    return content
      .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
      .map((b) => {
        let args: Record<string, unknown>
        try {
          args = b.arguments ? JSON.parse(b.arguments) : {}
        } catch {
          // JSON.parse 失败不崩溃：保留原文，交给工具层做参数校验
          args = { _raw: b.arguments }
        }
        return { id: b.id, name: b.name, args }
      })
  }
}

// ─── toApiMessages — 历史消息 → API 格式 ───

export function toApiMessages(history: DerivedMessage[]): ApiMessage[] {
  const out: ApiMessage[] = []

  for (const msg of history) {
    switch (msg.role) {
      case 'user':
        out.push({ role: 'user', content: msg.content })
        break

      case 'assistant': {
        const textParts: string[] = []
        const toolCalls: ApiToolCall[] = []

        for (const block of msg.content) {
          switch (block.type) {
            case 'text':
              textParts.push(block.text)
              break
            case 'tool-call':
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: block.arguments },
              })
              break
            // tool-result 不在 assistant 消息中
          }
        }

        out.push({
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        break
      }

      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: msg.callId,
          content: msg.content,
        })
        break
    }
  }

  return out
}

// ─── LlmAdapter 类 ───

export class LlmAdapter {
  private client: OpenAI
  private ctx: Context
  private currentTurn = 0
  private currentStep = 0

  constructor(config: { apiKey: string; baseURL?: string; ctx: Context }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })
    this.ctx = config.ctx
  }

  /** 设置当前 turn/step（供 chunk emit 用） */
  setCurrentTurn(turn: number, step: number): void {
    this.currentTurn = turn
    this.currentStep = step
  }

  /** 流式请求（带重试） */
  async stream(
    request: GenerateOptions,
    signal: AbortSignal,
  ): Promise<{ message: AssistantMessage; usage?: TokenUsage }> {
    return this.streamWithRetry(request, signal, 0)
  }

  private async streamWithRetry(
    request: GenerateOptions,
    signal: AbortSignal,
    attempt: number,
  ): Promise<{ message: AssistantMessage; usage?: TokenUsage }> {
    try {
      const assembler = new BlockAssembler()
      let usage: TokenUsage | undefined

      for await (const chunk of streamModel(this.client, request, signal)) {
        assembler.feed(chunk)
        // 提取 usage
        if (chunk.kind === 'finish' && chunk.usage) {
          usage = chunk.usage
        }
        // 实时广播流式 chunk（供 UI 渲染）
        this.ctx.emit('assistant/chunk', {
          turn: this.currentTurn,
          step: this.currentStep,
          chunk,
        })
      }

      const { content } = assembler.finish()

      const message: AssistantMessage = {
        id: generateId(),
        role: 'assistant',
        content,
      }

      return { message, usage }
    } catch (error: unknown) {
      // AbortError（用户取消）不重试
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError('Request aborted', 'ABORTED', { cause: error })
      }

      // OpenAI API 错误
      if (error instanceof OpenAI.APIError) {
        const status = error.status

        // 401 鉴权失败：不重试
        if (status === 401) {
          throw new LlmError(
            `Authentication failed: ${error.message}`,
            ErrorCode.AUTH,
            { status, cause: error },
          )
        }

        // 429 限流：指数退避重试（最多 3 次）
        if (status === 429 && attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
          await sleep(delay, signal)
          return this.streamWithRetry(request, signal, attempt + 1)
        }

        // 其他 API 错误
        throw new LlmError(
          `LLM API error (${status}): ${error.message}`,
          ErrorCode.UNKNOWN,
          { status, cause: error },
        )
      }

      // 网络超时：重试 1 次
      if (isNetworkError(error) && attempt < 1) {
        return this.streamWithRetry(request, signal, attempt + 1)
      }

      // 未知错误
      throw new LlmError(
        error instanceof Error ? error.message : String(error),
        ErrorCode.UNKNOWN,
        { cause: error },
      )
    }
  }
}

// ─── 工具函数 ───

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timer = setTimeout(resolve, ms)

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      error.message.includes('timeout') ||
      error.message.includes('ECONNRESET')
    )
  }
  return false
}
