// core/inbox.ts — 待处理消息队列

import type { UserMessage } from './session.js'

export class Inbox {
  private nextTurnQueue: UserMessage[] = []
  private nextStepQueue: UserMessage[] = []

  /** 追加消息到队列 */
  append(priority: 'next-turn' | 'next-step', message: UserMessage): void {
    if (priority === 'next-turn') {
      this.nextTurnQueue.push(message)
    } else {
      this.nextStepQueue.push(message)
    }
  }

  /** 认领消息（消耗队列） */
  claim(target: 'next-turn' | 'next-step', _turn: number): UserMessage[] {
    if (target === 'next-turn') {
      const messages = [...this.nextTurnQueue]
      this.nextTurnQueue = []
      return messages
    } else {
      const messages = [...this.nextStepQueue]
      this.nextStepQueue = []
      return messages
    }
  }

  /** 检查是否有待处理输入 */
  hasPending(): boolean {
    return this.nextTurnQueue.length > 0 || this.nextStepQueue.length > 0
  }

  /** 获取待处理数量 */
  get pendingCount(): number {
    return this.nextTurnQueue.length + this.nextStepQueue.length
  }
}
