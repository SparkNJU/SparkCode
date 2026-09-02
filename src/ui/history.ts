/**
 * 命令历史持久化
 * 对标 PaiCliHistory（简化版）
 *
 * 历史文件：~/.spark/history/input.history
 * 最大保留 2000 条，自动过滤敏感信息和超长行
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HISTORY_DIR = join(homedir(), '.spark', 'history')
const HISTORY_FILE = join(HISTORY_DIR, 'input.history')
const MAX_HISTORY = 2000
const MAX_LINE_LENGTH = 8000

/** 敏感信息模式（对标 PaiCliHistory 的过滤规则） */
const SENSITIVE_RE = /api[_-]?key|token|password|secret|bearer/i

/**
 * 加载历史记录（最近 MAX_HISTORY 条）
 */
export function loadHistory(): string[] {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    const content = readFileSync(HISTORY_FILE, 'utf-8')
    return content.split('\n').filter(Boolean).slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

/**
 * 追加一条历史记录
 * - 超长行丢弃
 * - 包含敏感信息的行丢弃
 */
export function appendHistory(line: string): void {
  if (!line || line.trim() === '') return
  if (line.length > MAX_LINE_LENGTH) return
  if (SENSITIVE_RE.test(line)) return

  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, line + '\n', { flag: 'a' })
  } catch {
    // 静默忽略写入错误
  }
}

/**
 * 清空历史记录
 */
export function clearHistory(): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, '', { flag: 'w' })
  } catch {
    // 静默忽略
  }
}
