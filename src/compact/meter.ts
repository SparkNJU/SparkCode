// compact/meter.ts — token 计量（自研轻量估算器）

/**
 * 估算文本的 token 数量
 * - 中文（CJK）：约 1.6 字符/token
 * - 英文/其他：约 4 字符/token
 *
 * 参考：tiktoken cl100k_base 统计
 * - CJK 字符平均 ~1.6 字符/token
 * - 英文单词平均 ~4 字符/token（含空格）
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    // CJK 统一表意文字 + CJK 兼容表意文字
    if (ch.charCodeAt(0) >= 0x4e00 && ch.charCodeAt(0) <= 0x9fff) {
      cjk++
    } else if (ch.charCodeAt(0) >= 0x3400 && ch.charCodeAt(0) <= 0x4dbf) {
      cjk++
    } else if (ch.charCodeAt(0) >= 0xf900 && ch.charCodeAt(0) <= 0xfaff) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk / 1.6 + other / 4)
}

/**
 * ContentBlock 类型（简化版，用于 token 估算）
 * 使用宽松类型以兼容不同的消息来源
 */
interface ContentBlockForEstimate {
  type: string
  text?: string
  arguments?: string
  name?: string
  content?: string
}

/**
 * 消息类型（简化版，用于 token 估算）
 */
interface MessageForEstimate {
  role: string
  content: string | ContentBlockForEstimate[]
}

/**
 * 估算 DerivedMessage[] 的总 token 数
 */
export function estimateMessagesTokens(messages: MessageForEstimate[]): number {
  let total = 0
  for (const msg of messages) {
    // role 标签 + 结构开销
    total += 4

    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      // AssistantMessage 的 content 是 ContentBlock[]
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += estimateTokens(block.text ?? '')
        } else if (block.type === 'tool-call') {
          total += estimateTokens(block.arguments ?? '') + estimateTokens(block.name ?? '') + 10
        } else if (block.type === 'tool-result') {
          total += estimateTokens(block.content ?? '') + 10
        }
      }
    }
  }
  return total
}
