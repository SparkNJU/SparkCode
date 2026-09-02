/**
 * Markdown → ANSI 终端渲染
 * 对标 PaiCLI TerminalMarkdownRenderer
 *
 * 支持：
 * - # 标题（粗体 + 下划线）
 * - **粗体** / *斜体*
 * - `行内代码`（chalk.bold.yellow）
 * - > 引用（dim cyan │ 前缀）
 * - 有序/无序列表
 * - 表格（边框 + 单元格换行）
 * - 代码块（┌─ code: lang / └─ end 边框）
 */

import chalk from 'chalk'
import { displayWidth } from './style.js'

// ─── 行内渲染 ──────────────────────────────────────────────

/**
 * 行内 Markdown 着色（粗体、斜体、行内代码、链接、删除线）
 * 不处理块级元素（标题、列表、表格等）
 */
export function renderInline(text: string): string {
  if (!text) return ''

  let result = text

  // 行内代码（反色）— 先处理避免内部被其他规则影响
  result = result.replace(/`([^`]+)`/g, (_, code) => chalk.bold.yellow(code))

  // 链接 [text](url) → text (url dim)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    `${chalk.bold(text)} ${chalk.dim(url)}`
  )

  // 粗体 **text** 或 __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
  result = result.replace(/__(.+?)__/g, (_, t) => chalk.bold(t))

  // 斜体 *text* 或 _text_（不匹配 ** 已处理的部分）
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => chalk.italic(t))
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, t) => chalk.italic(t))

  // 删除线 ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_, t) => chalk.dim(t))

  return result
}

// ─── 块级渲染 ──────────────────────────────────────────────

/**
 * 完整 Markdown 渲染（块级 + 行内）
 * 输入完整 markdown 文本，输出 ANSI 格式化字符串
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''

  const lines = text.split('\n')
  const output: string[] = []
  let inCodeBlock = false
  let codeLanguage = ''
  let pendingTable: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // 代码块检测
    if (trimmed.startsWith('```')) {
      flushPendingTable(pendingTable, output)
      pendingTable = []
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLanguage = trimmed.slice(3).trim()
        const label = codeLanguage ? `code: ${codeLanguage}` : 'code'
        output.push(chalk.bold.yellow(`┌─ ${label}`))
      } else {
        inCodeBlock = false
        output.push(chalk.bold.yellow('└─ end'))
        output.push('')
      }
      continue
    }

    // 代码块内 — 原样输出
    if (inCodeBlock) {
      output.push('    ' + line)
      continue
    }

    // 表格行检测
    if (looksLikeTableLine(trimmed)) {
      pendingTable.push(line)
      continue
    }

    // 非表格行 → 先刷出挂起的表格
    flushPendingTable(pendingTable, output)
    pendingTable = []

    // 空行
    if (trimmed === '') {
      output.push('')
      continue
    }

    // 标题
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = renderInline(headingMatch[2].trim())
      const underline = level === 1 ? '=' : '-'
      const width = Math.max(displayWidth(content), 4)
      output.push(chalk.bold.underline(content))
      output.push(chalk.dim(underline.repeat(width)))
      output.push('')
      continue
    }

    // 有序列表
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (orderedMatch) {
      const indent = '  '.repeat(Math.floor((orderedMatch[1]?.length || 0) / 2))
      output.push(`${indent}${orderedMatch[2]}. ${renderInline(orderedMatch[3].trim())}`)
      continue
    }

    // 无序列表
    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (unorderedMatch) {
      const indent = '  '.repeat(Math.floor((unorderedMatch[1]?.length || 0) / 2))
      output.push(`${indent}• ${renderInline(unorderedMatch[2].trim())}`)
      continue
    }

    // 引用
    if (trimmed.startsWith('>')) {
      output.push(chalk.dim.cyan('│ ') + renderInline(trimmed.slice(1).trim()))
      continue
    }

    // 普通段落
    output.push(renderInline(line))
  }

  // 刷出残留的表格和代码块
  flushPendingTable(pendingTable, output)
  if (inCodeBlock) {
    output.push(chalk.bold.yellow('└─ end'))
  }

  return output.join('\n')
}

// ─── 表格渲染 ──────────────────────────────────────────────

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const MIN_CELL_WIDTH = 4
const MAX_COLUMNS = 120

function looksLikeTableLine(line: string): boolean {
  if (!line) return false
  if (TABLE_SEPARATOR_RE.test(line)) return true
  const pipeCount = (line.match(/\|/g) || []).length
  return pipeCount >= 2
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map(cell => cell.trim())
}

function buildTableBorder(widths: number[]): string {
  return '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+'
}

/**
 * 渲染表格行为 ANSI 行数组（对标 PaiCLI TerminalMarkdownRenderer）
 *
 * - 自动适配终端宽度
 * - 列宽按比例分配，超出时自动缩窄
 * - 单元格内容超宽时自动换行
 */
export function renderTable(pending: string[]): string[] {
  const output: string[] = []

  // 解析行（跳过分隔行）
  const rows: string[][] = []
  for (const line of pending) {
    if (TABLE_SEPARATOR_RE.test(line.trim())) continue
    const cells = parseTableRow(line)
    if (cells.length > 0) rows.push(cells)
  }

  if (rows.length === 0) return output

  const columnCount = Math.max(...rows.map(r => r.length))

  // 1. 计算每列的自然宽度（内容最大显示宽度）
  const naturalWidths = new Array(columnCount).fill(MIN_CELL_WIDTH)
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      const cell = i < row.length ? renderInline(row[i]) : ''
      naturalWidths[i] = Math.max(naturalWidths[i], displayWidth(cell))
    }
  }

  // 2. 按终端宽度分配列宽（对标 PaiCLI allocateTableWidths）
  const widths = allocateTableWidths(naturalWidths, columnCount)

  // 3. 渲染边框
  const border = buildTableBorder(widths)
  output.push(chalk.dim(border))

  // 4. 渲染每行（支持多行换行）
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]

    // 将每个单元格内容按列宽换行
    const wrappedCells: string[][] = []
    let rowHeight = 1
    for (let i = 0; i < columnCount; i++) {
      const cell = i < row.length ? renderInline(row[i]) : ''
      const wrapped = wrapCell(cell, widths[i])
      wrappedCells.push(wrapped)
      rowHeight = Math.max(rowHeight, wrapped.length)
    }

    // 输出每一行（多行单元格逐行输出）
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
      let line = '|'
      for (let i = 0; i < columnCount; i++) {
        const cellLine = lineIdx < wrappedCells[i].length ? wrappedCells[i][lineIdx] : ''
        line += ` ${padRightDisplay(cellLine, widths[i])} |`
      }
      output.push(ri === 0 ? chalk.bold(line) : line)
    }

    // 表头后加分隔线
    if (ri === 0 && rows.length > 1) {
      output.push(chalk.dim(border))
    }
  }
  output.push(chalk.dim(border))

  return output
}

/**
 * 按终端宽度分配列宽（对标 PaiCLI allocateTableWidths）
 *
 * 策略：
 * 1. 可用宽度 = 终端列数 - 边框开销（每列3字符：` | ` + 首尾 `|`）
 * 2. 先按自然宽度分配，超出可用宽度时逐列缩窄最宽的
 * 3. 缩窄后仍有余量时，逐列加宽最需要的
 */
function allocateTableWidths(naturalWidths: number[], columnCount: number): number[] {
  const terminalCols = getTerminalColumns()
  // 边框开销：每列 ` ` + ` |` = 3字符，首尾 `+` = 1字符
  const available = Math.max(columnCount * MIN_CELL_WIDTH, terminalCols - (columnCount * 3 + 1))

  const widths = new Array(columnCount).fill(MIN_CELL_WIDTH)
  let used = 0

  // 初始分配：取自然宽度和上限的较小值
  for (let i = 0; i < columnCount; i++) {
    const headerWidth = naturalWidths[i]
    const minWidth = Math.max(MIN_CELL_WIDTH, Math.min(12, Math.max(headerWidth, MIN_CELL_WIDTH)))
    widths[i] = Math.min(Math.max(naturalWidths[i], MIN_CELL_WIDTH), minWidth)
    used += widths[i]
  }

  // 超出可用宽度 → 逐列缩窄最宽的
  while (used > available) {
    let candidate = -1
    for (let i = 0; i < columnCount; i++) {
      if (widths[i] <= MIN_CELL_WIDTH) continue
      if (candidate < 0 || widths[i] > widths[candidate]) candidate = i
    }
    if (candidate < 0) break
    widths[candidate]--
    used--
  }

  // 有余量 → 逐列加宽最需要的
  let remaining = available - used
  while (remaining > 0) {
    let candidate = -1
    let maxGap = 0
    for (let i = 0; i < columnCount; i++) {
      const gap = naturalWidths[i] - widths[i]
      if (gap <= 0) continue
      if (candidate < 0 || gap > maxGap) {
        candidate = i
        maxGap = gap
      }
    }
    if (candidate < 0) break
    widths[candidate]++
    remaining--
  }

  return widths
}

/**
 * 将单元格内容按指定宽度换行（对标 PaiCLI wrapCell）
 *
 * 按显示宽度换行，正确处理 CJK 宽字符
 */
function wrapCell(text: string, width: number): string[] {
  const lines: string[] = []
  const targetWidth = Math.max(MIN_CELL_WIDTH, width)
  const content = text.trim()

  if (!content) {
    lines.push('')
    return lines
  }

  let currentLine = ''
  let currentWidth = 0

  for (const char of content) {
    const cp = char.codePointAt(0)!
    const charWidth = isWideChar(cp) ? 2 : 1

    if (currentWidth > 0 && currentWidth + charWidth > targetWidth) {
      lines.push(currentLine)
      currentLine = ''
      currentWidth = 0
    }
    currentLine += char
    currentWidth += charWidth
  }

  if (currentLine || lines.length === 0) {
    lines.push(currentLine)
  }

  return lines
}

function getTerminalColumns(): number {
  try {
    return Math.max(40, process.stdout.columns || MAX_COLUMNS)
  } catch {
    return MAX_COLUMNS
  }
}

function isWideChar(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF)
      || (cp >= 0x3000 && cp <= 0x303F)
      || (cp >= 0xFF01 && cp <= 0xFF60)
      || (cp >= 0x3040 && cp <= 0x309F)
      || (cp >= 0x30A0 && cp <= 0x30FF)
      || (cp >= 0x1F300 && cp <= 0x1FAFF)
}

function flushPendingTable(pending: string[], output: string[]): void {
  if (pending.length === 0) return
  const rendered = renderTable(pending)
  pending.length = 0
  output.push(...rendered)
  output.push('')
}

function padRightDisplay(text: string, width: number): string {
  const dw = displayWidth(text)
  if (dw >= width) return text
  return text + ' '.repeat(width - dw)
}

// ─── 辅助 ──────────────────────────────────────────────────

/**
 * 检测文本是否包含 Markdown 语法
 */
export function hasMarkdownSyntax(text: string): boolean {
  return /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>\s|\*\*.+?\*\*|`.+?`|\[.+?\]\(.+?\)|```/.test(text)
}
