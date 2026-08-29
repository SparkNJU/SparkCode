// core/loop.ts — Agent 循环（turn/step 状态机 + 工具执行）

import type { SparkConfig } from '../config.js'
import type { Context } from './context.js'
import { Session, generateId, type UserMessage, type ContentBlock } from './session.js'
import type { GenerateOptions } from './llm.js'
import { Inbox } from './inbox.js'
import { assemblePrompt, type PromptAssembly } from './prompt.js'
import { LlmAdapter, toApiMessages } from './llm.js'
import { toLlmFailure } from './error.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface Agent {
  readonly session: Session
  readonly inbox: Inbox
  readonly ctx: Context
  readonly cwd: string
  readonly tools: ToolRegistry

  followup(content: string): void
  steer(content: string): void
  cancel(reason: string): void
  waitForTurnEnd(): Promise<void>
}

export class SparkAgent implements Agent {
  readonly session: Session
  readonly inbox: Inbox
  readonly ctx: Context
  readonly cwd: string
  readonly tools: ToolRegistry

  private config: SparkConfig
  private llm: LlmAdapter
  private phase: 'idle' | 'running' = 'idle'
  private turn = 0
  private step = 0
  private abort: AbortController | null = null

  // 回合结束通知
  private turnEndResolve: (() => void) | null = null
  private turnEndPromise: Promise<void> | null = null

  constructor(ctx: Context, config: SparkConfig) {
    this.ctx = ctx
    this.config = config
    this.cwd = config.workspace
    this.session = new Session()
    this.inbox = new Inbox()
    this.llm = ctx.get<LlmAdapter>('llm')
    this.tools = ctx.get<ToolRegistry>('tools')
  }

  /** 用户输入 → 新 turn */
  followup(content: string): void {
    const msg: UserMessage = {
      id: generateId(),
      role: 'user',
      content,
      source: 'human',
    }
    this.inbox.append('next-turn', msg)
    this.wakeDriver()
  }

  /** 追加输入 → 当前 step */
  steer(content: string): void {
    const msg: UserMessage = {
      id: generateId(),
      role: 'user',
      content,
      source: 'human',
    }
    this.inbox.append('next-step', msg)
    this.wakeDriver()
  }

  /** 注入系统上下文 */
  inject(content: string): void {
    const msg: UserMessage = {
      id: generateId(),
      role: 'user',
      content,
      source: 'injected',
    }
    this.inbox.append('next-step', msg)
  }

  /** 取消当前回合 */
  cancel(reason: string): void {
    this.abort?.abort(reason)
  }

  /** 等待当前回合完成 */
  waitForTurnEnd(): Promise<void> {
    if (this.phase === 'idle') return Promise.resolve()
    if (!this.turnEndPromise) {
      this.turnEndPromise = new Promise((resolve) => {
        this.turnEndResolve = resolve
      })
    }
    return this.turnEndPromise
  }

  // ─── 内部方法 ───

  private wakeDriver(): void {
    if (this.phase !== 'idle') return
    this.phase = 'running'
    this.turnEndPromise = null
    this.turnEndResolve = null

    this.runDriver().finally(() => {
      this.phase = 'idle'
      this.turnEndResolve?.()
      this.turnEndResolve = null
      this.turnEndPromise = null
    })
  }

  private async runDriver(): Promise<void> {
    try {
      while (await this.runTurn()) {
        // 继续处理下一个 turn
      }
    } catch (error) {
      console.error('\n[Agent] error:', error instanceof Error ? error.message : error)
    }
  }

  /** 运行一个回合：支持 multi-step 工具调用 */
  private async runTurn(): Promise<boolean> {
    this.turn++
    this.step = 0
    this.abort = new AbortController()

    this.session.append('turn/start', { turn: this.turn })

    try {
      // (A) 认领 next-turn 输入
      const messages = this.inbox.claim('next-turn', this.turn)
      if (messages.length === 0) {
        this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
        return false
      }

      // 记录用户消息
      this.session.append('step/start', { turn: this.turn, step: this.step })
      for (const m of messages) {
        this.session.append('user/message', m, { surfaceOp: 'append' })
      }

      // (B) 主循环：LLM 请求 → tool-call → 执行 → 循环
      while (true) {
        // 组装 prompt（通过 waterfall，支持中间件扩展）
        const tools = this.tools.hasTools() ? this.tools.schemas() : undefined
        const baseAssembly = assemblePrompt(this.session, this.config, tools)
        const assembly = await this.ctx.waterfall<PromptAssembly>(
          'prompt/assemble',
          baseAssembly,
        )

        // 构建历史 + API 消息
        const history = this.session.deriveMessages()
        const apiMessages = [
          { role: 'system' as const, content: assembly.header.systemPrompt },
          ...toApiMessages(history),
        ]
        const request: GenerateOptions = {
          model: assembly.header.model,
          messages: apiMessages,
          tools: assembly.header.tools,
        }

        // 记录请求头
        this.session.append('request/header', {
          header: { model: assembly.header.model, systemPrompt: assembly.header.systemPrompt },
          reason: 'change',
        })

        // 调用 LLM（流式）
        this.llm.setCurrentTurn(this.turn, this.step)
        const result = await this.llm.stream(request, this.abort.signal)

        // 记录 assistant 消息
        this.session.append('assistant/message', {
          turn: this.turn,
          step: this.step,
          message: result.message,
          usage: result.usage,
        }, { surfaceOp: 'append' })

        // 提取 tool-call
        const toolCalls = result.message.content
          .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')

        // 无 tool-call → 回合完成
        if (toolCalls.length === 0) {
          this.session.append('step/end', { turn: this.turn, step: this.step })
          break
        }

        // 执行工具调用
        await this.executeToolCalls(toolCalls)

        this.session.append('step/end', { turn: this.turn, step: this.step })

        // 检查 step 上限
        if (this.step >= this.config.maxStepsPerTurn) {
          break
        }

        // 准备下一步
        this.step++
        const nextMessages = this.inbox.claim('next-step', this.turn)
        this.session.append('step/start', { turn: this.turn, step: this.step })
        for (const m of nextMessages) {
          this.session.append('user/message', m, { surfaceOp: 'append' })
        }
      }

      // 回合结束
      this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
      return this.inbox.hasPending()
    } catch (error) {
      const failure = toLlmFailure(error)
      this.session.append('turn/end', {
        turn: this.turn,
        reason: { kind: 'error', error: failure },
      })
      throw error
    }
  }

  /** 执行工具调用（按模型顺序串行执行） */
  private async executeToolCalls(
    calls: Array<{ id: string; name: string; arguments: string }>,
  ): Promise<void> {
    // 记录所有 tool/call 事件
    for (const call of calls) {
      this.session.append('tool/call', {
        turn: this.turn,
        step: this.step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      })
    }

    // 串行执行
    for (const call of calls) {
      let args: Record<string, unknown>
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        args = { _raw: call.arguments }
      }

      const result = await this.tools.execute(
        { id: call.id, name: call.name, args },
        {
          signal: this.abort!.signal,
          agent: this,
          cwd: this.cwd,
          deferContext: (msg) => this.inject(msg),
          writeEvent: (type, data) => {
            this.session.append(type as any, data as any)
          },
        },
      )

      // 记录 tool/result 事件
      this.session.append('tool/result', {
        turn: this.turn,
        step: this.step,
        message: {
          id: generateId(),
          role: 'tool',
          callId: call.id,
          content: result.content,
          isError: result.isError,
        },
        error: result.isError ? { name: 'ToolError', code: 'TOOL_FAILED' } : undefined,
      }, { surfaceOp: 'append' })
    }
  }
}
