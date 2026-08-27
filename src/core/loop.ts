// core/loop.ts — Agent 循环（turn/step 状态机）

import type { SparkConfig } from '../config.js'
import type { Context } from './context.js'
import { Session, generateId, type UserMessage, type AssistantMessage } from './session.js'
import { Inbox } from './inbox.js'
import { assemblePrompt } from './prompt.js'
import { LlmAdapter, toApiMessages } from './llm.js'
import { toLlmFailure } from './error.js'

export interface Agent {
  readonly session: Session
  readonly inbox: Inbox
  readonly ctx: Context
  readonly cwd: string

  followup(content: string): void
  steer(content: string): void
  cancel(reason: string): void

  /** 等待当前回合完成 */
  waitForTurnEnd(): Promise<void>
}

export class SparkAgent implements Agent {
  readonly session: Session
  readonly inbox: Inbox
  readonly ctx: Context
  readonly cwd: string

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

  /** 追加输入 → 当前 step（M2 用） */
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

  /** 运行一个回合，返回是否还有待处理输入 */
  private async runTurn(): Promise<boolean> {
    this.turn++
    this.step = 0
    this.abort = new AbortController()

    this.session.append('turn/start', { turn: this.turn })

    try {
      // (A) 认领输入
      const messages = this.inbox.claim('next-turn', this.turn)
      if (messages.length === 0) {
        this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
        return false
      }

      // (B) 组装 prompt
      const assembly = assemblePrompt(this.session, this.config)

      this.session.append('step/start', { turn: this.turn, step: this.step })
      for (const m of messages) {
        this.session.append('user/message', m, { surfaceOp: 'append' })
      }

      // (C) 构建历史 + 调 LLM
      const history = this.session.deriveMessages()
      const apiMessages = [
        { role: 'system' as const, content: assembly.header.systemPrompt },
        ...toApiMessages(history),
      ]
      const request = {
        model: assembly.header.model,
        messages: apiMessages,
      }

      // 记录请求头
      this.session.append('request/header', {
        header: { model: assembly.header.model, systemPrompt: assembly.header.systemPrompt },
        reason: 'change',
      })

      this.llm.setCurrentTurn(this.turn, this.step)
      const result = await this.llm.stream(request, this.abort.signal)

      // (D) 记录结果
      this.session.append('assistant/message', {
        turn: this.turn,
        step: this.step,
        message: result.message,
        usage: result.usage,
      }, { surfaceOp: 'append' })

      this.session.append('step/end', { turn: this.turn, step: this.step })
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
}
