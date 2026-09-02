/**
 * 简化版输入高亮
 * 对标 PaiCliHighlighter，但受限于 Node readline API
 *
 * 方案：在用户按 Enter 后、发送前，对输入做着色回显
 * （不实现实时着色——Node readline 不支持 Highlighter 接口）
 */

import chalk from 'chalk'

/**
 * 对用户输入做语法着色
 * - /command → cyan bold（slash 命令）
 * - !shell → yellow（shell 命令）
 * - 其他 → 原样
 */
export function highlightInput(input: string): string {
  if (!input) return ''
  if (input.startsWith('/')) {
    return chalk.cyan.bold(input)
  }
  if (input.startsWith('!')) {
    return chalk.yellow(input)
  }
  return input
}
