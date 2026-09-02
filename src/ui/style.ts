// ui/style.ts — 终端样式辅助（基于 chalk）
// 对标 PaiCLI AnsiStyle.java

import chalk from 'chalk'
import { supportsAnsi } from './caps.js'

const enabled = supportsAnsi()

/** 标题：粗体青色 */
export function heading(text: string): string {
  return enabled ? chalk.bold.cyan(text) : text
}

/** 区段：粗体绿色（用于 logo 色块） */
export function section(text: string): string {
  return enabled ? chalk.bold.green(text) : text
}

/** 次要信息：暗灰色 */
export function subtle(text: string): string {
  return enabled ? chalk.dim.gray(text) : text
}

/** 思考内容：斜体灰色 */
export function thinking(text: string): string {
  return enabled ? chalk.italic.gray(text) : text
}

/** 代码标签：粗体黄色 */
export function codeLabel(text: string): string {
  return enabled ? chalk.bold.yellow(text) : text
}

/** 错误：粗体红色 */
export function error(text: string): string {
  return enabled ? chalk.bold.red(text) : text
}

/** 强调：粗体 */
export function emphasis(text: string): string {
  return enabled ? chalk.bold(text) : text
}

/** 引用前缀：暗青色 */
export function quotePrefix(text: string): string {
  return enabled ? chalk.dim.cyan(text) : text
}

/** 成功：绿色 */
export function success(text: string): string {
  return enabled ? chalk.green(text) : text
}

/** 警告：黄色 */
export function warn(text: string): string {
  return enabled ? chalk.yellow(text) : text
}

/**
 * 用户消息块（紫色前缀 + 深色背景）
 * 对标 PaiCLI AnsiStyle.userMessageBlock
 */
export function userMessageBlock(text: string, columns: number): string {
  const safe = text ?? ''
  const width = Math.max(20, columns)
  const lines = safe.split('\n')

  return lines.map(line => {
    const prefix = '> '
    const content = prefix + line
    const padding = Math.max(0, width - displayWidth(content))
    if (!enabled) return content + ' '.repeat(padding)
    return chalk.bgRgb(50, 50, 50).hex('#8B5CF6')(prefix)
      + chalk.bgRgb(50, 50, 50)(line)
      + ' '.repeat(padding)
      + chalk.reset('')
  }).join('\n')
}

/**
 * CJK 安全的显示宽度计算
 * 对标 PaiCLI AnsiStyle.displayWidth
 */
export function displayWidth(text: string): number {
  if (!text) return 0
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    width += isWideChar(code) ? 2 : 1
  }
  return width
}

/** 判定是否宽字符（CJK / Emoji 等占 2 列的字符） */
function isWideChar(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF)      // CJK Unified Ideographs
    || (cp >= 0x3000 && cp <= 0x303F)         // CJK Symbols and Punctuation
    || (cp >= 0xFF01 && cp <= 0xFF60)         // Fullwidth Forms
    || (cp >= 0x3040 && cp <= 0x309F)         // Hiragana
    || (cp >= 0x30A0 && cp <= 0x30FF)         // Katakana
    || (cp >= 0x1F300 && cp <= 0x1FAFF)       // Emoji / Symbols
    || (cp >= 0x2600 && cp <= 0x27BF)         // Misc Symbols
    || (cp >= 0xFE30 && cp <= 0xFE4F)         // CJK Compatibility Forms
}

/** 去除 ANSI 转义序列 */
export function stripAnsi(text: string): string {
  if (!text) return ''
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
}
