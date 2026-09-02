// core/loop.ts — Agent 循环（turn/step 状态机 + 工具执行）

import type { SparkConfig } from '../config.js'
import type { Context } from './context.js'
import { Session, generateId, type UserMessage, type ContentBlock, type SessionEvent } from './session.js'
import type { GenerateOptions } from './llm.js'
import { Inbox } from './inbox.js'
import { assemblePrompt, type PromptAssembly } from './prompt.js'
import { LlmAdapter, toApiMessages } from './llm.js'
import { toLlmFailure } from './error.js'
import type { ToolRegistry } from '../tools/registry.js'
import { trimToolResult, needsCompaction, findCompactionCutPoint, messagesToSummaryText, DEFAULT_COMPACTION_CONFIG } from '../compact/basic.js'
import { estimateMessagesTokens, estimateTokens } from '../compact/meter.js'
import { JsonlWriter } from '../persist/writer.js'
import { SessionStore } from '../persist/store.js'
import { readJsonl } from '../persist/reader.js'
import { MODE_CONFIGS, type AgentMode } from './modes.js'
import { EFFORT_PROMPTS, type EffortLevel } from './effort.js'

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
  session: Session
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

  // M5: 持久化
  private writer: JsonlWriter | null = null
  private store: SessionStore
  private _persistenceEnabled = false

  // M6: 交互增强
  private _currentModel: string
  private _currentBaseURL?: string
  private _mode: AgentMode = 'normal'
  private _effort: EffortLevel = 'medium'

  constructor(ctx: Context, config: SparkConfig) {
    this.ctx = ctx
    this.config = config
    this.cwd = config.workspace
    this.session = new Session()
    this.inbox = new Inbox()
    this.llm = ctx.get<LlmAdapter>('llm')
    this.tools = ctx.get<ToolRegistry>('tools')
    this.store = new SessionStore()
    this._currentModel = config.model
    this._currentBaseURL = config.provider.baseURL
  }

  // ─── M6: 交互增强方法 ───

  /** 获取当前模型名 */
  get currentModel(): string { return this._currentModel }

  /** 切换模型 */
  setModel(model: string, baseURL?: string): void {
    this._currentModel = model
    if (baseURL) this._currentBaseURL = baseURL
    this.llm.updateConfig({ model, baseURL })
    this.inject(`[系统: 模型已切换为 ${model}]`)
  }

  /** 获取当前模式 */
  get mode(): AgentMode { return this._mode }

  /** 切换模式 */
  setMode(mode: AgentMode): void {
    this._mode = mode
    const config = MODE_CONFIGS[mode]
    // 设置工具过滤器
    this.tools.setFilter(config.toolFilter)
    if (config.promptInjection) {
      this.inject(`[系统: 已切换到${mode}模式。${config.description}]`)
    }
  }

  /** 获取当前推理深度 */
  get effort(): EffortLevel { return this._effort }

  /** 设置推理深度 */
  setEffort(level: EffortLevel): void {
    this._effort = level
    const prompt = EFFORT_PROMPTS[level]
    if (prompt) {
      this.inject(`[系统: 推理深度已设置为${level}。${prompt}]`)
    }
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

  // ─── M5: 持久化方法 ───

  /** 启用持久化 */
  enablePersistence(): void {
    this.writer = new JsonlWriter(this.store.baseDir, this.session.id)
    this._persistenceEnabled = true
  }

  /** 停用持久化（删除当前活跃会话磁盘文件后调用） */
  disablePersistence(): void {
    this.writer?.close()
    this.writer = null
    this._persistenceEnabled = false
  }

  /** 恢复会话 */
  async resume(sessionId: string): Promise<void> {
    const filePath = this.store.jsonlPath(sessionId)
    const events = readJsonl(filePath)
    if (events.length === 0) {
      throw new Error(`会话 ${sessionId} 不存在或为空`)
    }
    this.writer?.close()
    this.session.replay(events)
    this.writer = new JsonlWriter(this.store.baseDir, sessionId)
    this._persistenceEnabled = true
    this.saveCurrentMeta()
  }

  /** 新建会话 */
  newSession(): void {
    this.saveCurrentMeta()
    this.writer?.close()
    this.session = new Session()
    this.writer = new JsonlWriter(this.store.baseDir, this.session.id)
    this._persistenceEnabled = true
  }

  /** 保存当前会话元数据 */
  saveCurrentMeta(): void {
    const log = this.session.getLog()
    const userMessages = log.filter(e => e.type === 'user/message')
    const firstUserMsg = userMessages[0]
    const title = firstUserMsg?.data?.content
      ? (firstUserMsg.data.content as string).slice(0, 40)
      : ''

    this.store.saveMeta({
      id: this.session.id,
      createdAt: log.length > 0 ? log[0]!.time : Date.now(),
      lastActiveAt: Date.now(),
      messageCount: userMessages.length,
      title,
    })
  }

  /** 重命名当前会话 */
  renameSession(title: string): void {
    this.store.saveMeta({
      id: this.session.id,
      createdAt: this.session.getLog()[0]?.time ?? Date.now(),
      lastActiveAt: Date.now(),
      messageCount: this.session.getLog().filter(e => e.type === 'user/message').length,
      title,
    })
  }

  /** 删除会话磁盘文件 */
  deleteSession(sessionId: string): void {
    this.store.delete(sessionId)
    // 如果删除的是当前活跃会话，停用持久化
    if (sessionId === this.session.id) {
      this.disablePersistence()
    }
  }

  /** 检查持久化是否启用 */
  get persistenceEnabled(): boolean {
    return this._persistenceEnabled
  }

  /** 获取会话存储 */
  getStore(): SessionStore {
    return this.store
  }

  // ─── 内部方法 ───

  /** 追加事件并同步写入 JSONL */
  private appendEvent<T extends SessionEvent['type']>(
    type: T,
    data: any,
    options?: { surfaceOp?: 'append' | { op: 'replace'; start: number; end: number } },
  ): any {
    const event = this.session.append(type, data, options)
    this.writer?.write(event as SessionEvent)
    return event
  }

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

    this.appendEvent('turn/start', { turn: this.turn })

    try {
      // (A) 认领 next-turn 输入
      const messages = this.inbox.claim('next-turn', this.turn)
      if (messages.length === 0) {
        this.appendEvent('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
        return false
      }

      // 记录用户消息
      this.appendEvent('step/start', { turn: this.turn, step: this.step })
      for (const m of messages) {
        this.appendEvent('user/message', m, { surfaceOp: 'append' })
      }

      // (B) 主循环：LLM 请求 → tool-call → 执行 → 循环
      while (true) {
        // M4: 上下文压缩检查（在 LLM 请求之前）
        if (this.config.compaction.enabled) {
          await this.maybeCompactContext()
        }

        // 组装 prompt（通过 waterfall，支持中间件扩展）
        const tools = this.tools.hasTools() ? this.tools.schemas() : undefined
        const baseAssembly = assemblePrompt(this.session, this.config, tools, {
          mode: this._mode,
          effort: this._effort,
          currentModel: this._currentModel,
        })
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
        this.appendEvent('request/header', {
          header: { model: assembly.header.model, systemPrompt: assembly.header.systemPrompt },
          reason: 'change',
        })

        // 调用 LLM（流式）
        this.llm.setCurrentTurn(this.turn, this.step)
        const result = await this.llm.stream(request, this.abort.signal)

        // 记录 assistant 消息
        this.appendEvent('assistant/message', {
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
          this.appendEvent('step/end', { turn: this.turn, step: this.step })
          break
        }

        // 执行工具调用
        await this.executeToolCalls(toolCalls)

        this.appendEvent('step/end', { turn: this.turn, step: this.step })

        // 检查 step 上限
        if (this.step >= this.config.maxStepsPerTurn) {
          break
        }

        // 准备下一步
        this.step++
        const nextMessages = this.inbox.claim('next-step', this.turn)
        this.appendEvent('step/start', { turn: this.turn, step: this.step })
        for (const m of nextMessages) {
          this.appendEvent('user/message', m, { surfaceOp: 'append' })
        }
      }

      // 回合结束
      this.appendEvent('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
      return this.inbox.hasPending()
    } catch (error) {
      const failure = toLlmFailure(error)
      this.appendEvent('turn/end', {
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
      this.appendEvent('tool/call', {
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
            this.appendEvent(type as any, data as any)
          },
        },
      )

      // M4: 裁剪超长工具结果
      const trimmedContent = this.config.compaction.enabled
        ? trimToolResult(result.content)
        : result.content

      // 记录 tool/result 事件（使用裁剪后的内容）
      this.appendEvent('tool/result', {
        turn: this.turn,
        step: this.step,
        message: {
          id: generateId(),
          role: 'tool',
          callId: call.id,
          content: trimmedContent,
          isError: result.isError,
        },
        error: result.isError ? { name: 'ToolError', code: 'TOOL_FAILED' } : undefined,
      }, { surfaceOp: 'append' })
    }
  }

  /**
   * 检查上下文大小，必要时执行摘要压缩
   * 公开方法：支持 /compact 命令手动触发
   */
  async maybeCompactContext(): Promise<void> {
    const messages = this.session.deriveMessages()
    const config = this.config.compaction

    if (!needsCompaction(messages, { ...DEFAULT_COMPACTION_CONFIG, threshold: config.threshold })) {
      return
    }

    // 找到压缩切割点
    const cutIndex = findCompactionCutPoint(messages, config.keepRecentTurns)
    if (cutIndex === 0) return // 没有可压缩的内容

    // 提取要压缩的消息
    const toCompact = messages.slice(0, cutIndex)
    const summaryText = messagesToSummaryText(toCompact)

    // 用 LLM 生成摘要（独立请求）
    const summaryPrompt = DEFAULT_COMPACTION_CONFIG.summaryPrompt
    const summaryResult = await this.llm.stream(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: summaryText },
        ],
      },
      this.abort!.signal,
    )

    // 提取摘要文本
    const summaryBlock = summaryResult.message.content.find(b => b.type === 'text')
    const summary = summaryBlock?.text ?? '（摘要生成失败）'

    // 用 replace 标记替换模型视角
    // 删除 derivedMessages[0..cutIndex)，插入摘要消息
    this.appendEvent('agent/inbox/spliced', {
      target: 'next-step',
      messages: [{
        id: generateId(),
        role: 'user',
        content: `[对话摘要]\n${summary}`,
        source: 'injected',
      }],
    }, {
      surfaceOp: {
        op: 'replace',
        start: 0,
        end: cutIndex,
      },
    })

    // 广播压缩事件（供 UI 显示）
    this.ctx.emit('compact/done', {
      originalTokens: estimateMessagesTokens(toCompact as Array<{ role: string; content: string | Array<{ type: string; text?: string; arguments?: string; name?: string; content?: string }> }>),
      summaryTokens: estimateTokens(summary),
      cutIndex,
    })
  }
}
