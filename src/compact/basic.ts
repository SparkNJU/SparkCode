// compact/basic.ts — 结果裁剪 + 摘要压缩（两级压缩策略）

import { estimateTokens, estimateMessagesTokens } from './meter.js'

// ─── 工具结果裁剪（第一级） ───

/** 裁剪阈值：单个工具结果超过此字符数时触发裁剪 */
const TRIM_THRESHOLD_CHARS = 10_000

/** 裁剪后保留的字符数 */
const TRIM_MAX_CHARS = 4_000

/**
 * 裁剪超长工具结果
 * 策略：头部 80% + 尾部 20% + 落盘提示
 *
 * 与 M3 的 count-based 截断不同：
 * - M3 截断发生在工具内部（glob 1000 条、grep 500 条）
 * - M4 裁剪发生在工具结果进入历史前（兜底保护）
 */
export function trimToolResult(content: string): string {
  if (content.length <= TRIM_THRESHOLD_CHARS) {
    return content
  }

  const headLen = Math.floor(TRIM_MAX_CHARS * 0.8)
  const tailLen = TRIM_MAX_CHARS - headLen

  const head = content.slice(0, headLen)
  const tail = content.slice(-tailLen)

  const dropped = content.length - headLen - tailLen
  const notice = `\n\n... [已裁剪 ${dropped} 字符，原始 ${content.length} 字符] ...\n\n`

  return head + notice + tail
}

// ─── 摘要压缩（第二级） ───

/** 摘要压缩配置 */
export interface CompactionConfig {
  /** 触发摘要压缩的 token 阈值 */
  threshold: number
  /** 每次压缩保留最近 N 轮不动 */
  keepRecentTurns: number
  /** 摘要系统提示词 */
  summaryPrompt: string
}

/** 默认配置 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  threshold: 80_000,      // 128K 窗口的 ~62%
  keepRecentTurns: 3,     // 保留最近 3 轮
  summaryPrompt: `你是一个对话摘要助手。请将以下对话历史压缩为简洁的摘要，保留：
1. 用户的核心需求和目标
2. 已完成的关键操作和结果
3. 未完成的任务或待解决的问题
4. 重要的代码文件路径和修改内容

输出纯文本摘要，不要使用 Markdown 格式。`,
}

/**
 * 检查是否需要压缩
 */
export function needsCompaction(messages: Array<{ role: string; content: unknown }>, config: CompactionConfig): boolean {
  const tokens = estimateMessagesTokens(messages as Array<{ role: string; content: string | Array<{ type: string; text?: string; arguments?: string; name?: string; content?: string }> }>)
  return tokens > config.threshold
}

/**
 * 找到压缩切割点
 * 返回值：要压缩的消息范围 [0, cutIndex)
 * 保留最近 keepRecentTurns 个用户消息之后的所有内容
 */
export function findCompactionCutPoint(messages: Array<{ role: string }>, keepRecentTurns: number): number {
  let userMessageCount = 0
  let cutIndex = 0

  // 从后往前数 user 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      userMessageCount++
      if (userMessageCount >= keepRecentTurns) {
        cutIndex = i
        break
      }
    }
  }

  // 确保至少压缩一些内容
  if (cutIndex === 0 && messages.length > 10) {
    cutIndex = Math.floor(messages.length * 0.6)
  }

  return cutIndex
}

/**
 * 从消息列表中提取要压缩的文本
 */
export function messagesToSummaryText(messages: Array<{ role: string; content: unknown }>): string {
  const parts: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        parts.push(`[用户] ${msg.content}`)
        break
      case 'assistant': {
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text?: string }) => b.text || '')
          if (textBlocks.length > 0) {
            parts.push(`[助手] ${textBlocks.join('')}`)
          }
          const toolCalls = msg.content
            .filter((b: { type: string }) => b.type === 'tool-call')
            .map((b: { name?: string; arguments?: string }) => `${b.name || ''}(${(b.arguments || '').slice(0, 100)})`)
          if (toolCalls.length > 0) {
            parts.push(`[工具调用] ${toolCalls.join(', ')}`)
          }
        } else if (typeof msg.content === 'string' && msg.content) {
          parts.push(`[助手] ${msg.content}`)
        }
        break
      }
      case 'tool':
        parts.push(`[工具结果] ${typeof msg.content === 'string' ? msg.content.slice(0, 200) : ''}`)
        break
    }
  }
  return parts.join('\n')
}
