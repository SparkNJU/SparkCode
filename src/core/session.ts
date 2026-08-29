// core/session.ts — 事件日志（唯一事实源）+ 消息投影

import type { LlmFailure } from './error.js'

// ─── 消息类型（LLM 层） ───

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; callId: string; content: string; isError: boolean }

export interface UserMessage {
  id: string
  role: 'user'
  content: string
  source: 'human' | 'injected'
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  content: ContentBlock[]
}

export interface ToolResultMessage {
  id: string
  role: 'tool'
  callId: string
  content: string
  isError: boolean
}

export type DerivedMessage = UserMessage | AssistantMessage | ToolResultMessage

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// ─── 流式 chunk ───

export type StreamChunk =
  | { kind: 'content'; text: string }
  | { kind: 'tool-call-part'; index: number; id?: string; name?: string; argsFragment: string }
  | { kind: 'finish'; reason: string | null; usage?: TokenUsage }

// ─── 回合结束原因 ───

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' }
  | { kind: 'error'; error: LlmFailure }
  | { kind: 'aborted'; reason: string }

// ─── 请求头 ───

export interface RequestHeader {
  model: string
  systemPrompt: string
}

// ─── Inbox splice ───

export interface InboxSplice {
  target: 'next-turn' | 'next-step'
  messages: UserMessage[]
}

// ─── Todo ───

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ─── 会话事件（判别联合） ───

export type SessionEvent =
  | { seq: number; time: number; type: 'turn/start'; data: { turn: number } }
  | { seq: number; time: number; type: 'turn/end'; data: { turn: number; reason: TurnEndReason } }
  | { seq: number; time: number; type: 'step/start'; data: { turn: number; step: number } }
  | { seq: number; time: number; type: 'step/end'; data: { turn: number; step: number } }
  | { seq: number; time: number; type: 'user/message'; data: UserMessage }
  | { seq: number; time: number; type: 'assistant/chunk'; data: { turn: number; step: number; chunk: StreamChunk } }
  | { seq: number; time: number; type: 'assistant/message'; data: { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage } }
  | { seq: number; time: number; type: 'tool/call'; data: { turn: number; step: number; callId: string; name: string; arguments: string } }
  | { seq: number; time: number; type: 'tool/result'; data: { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string } } }
  | { seq: number; time: number; type: 'request/header'; data: { header: RequestHeader; reason: 'initial' | 'resume' | 'change' } }
  | { seq: number; time: number; type: 'agent/inbox/spliced'; data: InboxSplice }
  | { seq: number; time: number; type: 'todo/write'; data: { todos: TodoItem[] } }

// ─── Session 类 ───

export class Session {
  readonly id: string
  private log: SessionEvent[] = []
  private seq = 0
  private derivedMessages: DerivedMessage[] = []
  private derivedCursor = 0

  constructor(id?: string) {
    this.id = id ?? generateId()
  }

  /** 追加事件，返回带 seq 的完整事件 */
  append<T extends SessionEvent['type']>(
    type: T,
    data: Extract<SessionEvent, { type: T }>['data'],
    options?: { surfaceOp?: 'append' | { op: 'replace'; start: number; end: number } },
  ): Extract<SessionEvent, { type: T }> {
    const event = {
      seq: this.seq++,
      time: Date.now(),
      type,
      data,
    } as Extract<SessionEvent, { type: T }>

    this.log.push(event as SessionEvent)

    // Surface 事件增量投影
    if (options?.surfaceOp === 'append') {
      this.projectEvent(event as SessionEvent)
    }

    return event
  }

  /** 从日志投影模型可见的消息历史 */
  deriveMessages(): DerivedMessage[] {
    // 增量投影：处理尚未投影的事件
    while (this.derivedCursor < this.log.length) {
      const event = this.log[this.derivedCursor]!
      this.derivedCursor++
      if (!this.isProjected(event)) {
        this.projectEvent(event)
      }
    }
    return [...this.derivedMessages]
  }

  /** 获取原始日志 */
  getLog(): readonly SessionEvent[] {
    return this.log
  }

  /** 重放事件序列（用于恢复） */
  replay(events: SessionEvent[]): void {
    this.log = []
    this.seq = 0
    this.derivedMessages = []
    this.derivedCursor = 0
    for (const event of events) {
      this.log.push(event)
      this.seq = Math.max(this.seq, event.seq + 1)
      this.derivedCursor = this.log.length
      // 重放时投影所有 surface 事件
      if (this.isSurfaceEvent(event)) {
        this.projectEvent(event)
      }
    }
  }

  /** 获取事件数量 */
  get length(): number {
    return this.log.length
  }

  /** 按 seq 查找事件 */
  findBySeq(seq: number): SessionEvent | undefined {
    return this.log.find(e => e.seq === seq)
  }

  // ─── 内部方法 ───

  private isSurfaceEvent(event: SessionEvent): boolean {
    return (
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      event.type === 'tool/result'
    )
  }

  private isProjected(event: SessionEvent): boolean {
    // 检查此事件是否已经通过 surfaceOp: 'append' 投影过
    // 对于 replay 的事件，isSurfaceEvent 判断即可
    return false // 增量模式下由 derivedCursor 控制
  }

  private projectEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message':
        this.derivedMessages.push(event.data)
        break
      case 'assistant/message': {
        const msg = event.data.message
        // 空内容跳过（仅含 usage 的事件）
        if (msg.content.length > 0) {
          this.derivedMessages.push(msg)
        }
        break
      }
      case 'tool/result':
        this.derivedMessages.push(event.data.message)
        break
      default:
        // 日志型事件不投影
        break
    }
  }
}

// ─── 工具函数 ───

let idCounter = 0

export function generateId(): string {
  return `${Date.now().toString(36)}_${(idCounter++).toString(36)}`
}
