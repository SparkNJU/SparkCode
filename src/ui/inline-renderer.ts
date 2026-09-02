import chalk from 'chalk'
import { BlockRegistry } from './block-registry.js'
import { FoldableBlock } from './foldable-block.js'
import { subtle } from './style.js'
import { renderInline, renderTable } from './markdown.js'

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/**
 * 流式渲染器 — 对标 PaiCLI InlineRenderer + TerminalMarkdownRenderer
 *
 * 块级累积状态机：
 * - 代码块：``` 围栏，缓冲 body，结束时 FoldableBlock
 * - 表格：连续 | 行，累积后整体渲染
 * - 标题/列表/引用/段落：块级元素检测 + 行内着色
 * - 块级元素间自动插入空行（对标 PaiCLI ensureBlockSpacing）
 */
export class InlineRenderer {
  private blockRegistry: BlockRegistry
  private inCodeBlock = false
  private codeLanguage = ''
  private codeBodyLines: string[] = []
  private codeFenceLine = ''
  private lineBuffer = ''
  private renderedRows = 0

  // 表格累积
  private pendingTable: string[] = []

  // 块间距追踪（对标 PaiCLI lastOutputBlank / needsLineBreakBeforeNextBlock）
  private lastOutputBlank = false
  private needsLineBreakBeforeNextBlock = false

  constructor(blockRegistry: BlockRegistry) {
    this.blockRegistry = blockRegistry
  }

  /** 流式写入 chunk（对标 createTranscriptStream.write） */
  write(chunk: string): void {
    for (const ch of chunk) {
      this.lineBuffer += ch
      if (ch === '\n') {
        this.processLine(this.lineBuffer)
        this.lineBuffer = ''
      }
    }
  }

  /** 逐行处理（核心状态机） */
  private processLine(rawLine: string): void {
    const line = rawLine.replace(/\r?\n$/, '')
    const trimmed = line.trim()

    // ── 1. 代码块检测 ─────────────────────────────────────
    const codeFenceMatch = trimmed.match(/^```(\w*)/)

    if (!this.inCodeBlock && codeFenceMatch) {
      this.flushPendingTable()
      this.inCodeBlock = true
      this.codeLanguage = codeFenceMatch[1] || ''
      this.codeFenceLine = line
      this.codeBodyLines = []
      return
    }

    if (this.inCodeBlock) {
      if (/^```\s*$/.test(trimmed)) {
        this.inCodeBlock = false
        const count = this.codeBodyLines.length
        const label = this.codeLanguage ? `code: ${this.codeLanguage}` : 'code'
        const header = subtle(`⏵ ${label} (${count} lines, ctrl+o to expand)`)
        const expanded = [this.codeFenceLine, ...this.codeBodyLines, line]
        const block = new FoldableBlock(header, expanded)
        this.blockRegistry.register(block)
        this.writeLine(header)
        this.writeBlankLine()
        return
      }
      this.codeBodyLines.push(line)
      return
    }

    // ── 2. 表格检测 ───────────────────────────────────────
    if (this.looksLikeTableLine(trimmed)) {
      this.pendingTable.push(line)
      return
    }

    this.flushPendingTable()

    // ── 3. 空行 ───────────────────────────────────────────
    if (trimmed === '') {
      this.writeBlankLine()
      return
    }

    // ── 4. 标题 ───────────────────────────────────────────
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      this.ensureBlockSpacing()
      const level = headingMatch[1].length
      const content = renderInline(headingMatch[2].trim())
      const underline = level === 1 ? '=' : '-'
      const width = Math.max(this.displayWidth(content), 4)
      this.writeLine(chalk.bold.underline(content))
      this.writeLine(subtle(underline.repeat(width)))
      this.writeBlankLine()
      return
    }

    // ── 5. 列表 ───────────────────────────────────────────
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (orderedMatch) {
      const indent = '  '.repeat(Math.floor((orderedMatch[1]?.length || 0) / 2))
      this.writeLine(`${indent}${orderedMatch[2]}. ${renderInline(orderedMatch[3].trim())}`)
      return
    }

    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (unorderedMatch) {
      const indent = '  '.repeat(Math.floor((unorderedMatch[1]?.length || 0) / 2))
      this.writeLine(`${indent}• ${renderInline(unorderedMatch[2].trim())}`)
      return
    }

    // ── 6. 引用 ───────────────────────────────────────────
    if (trimmed.startsWith('>')) {
      this.writeLine(chalk.dim.cyan('│ ') + renderInline(trimmed.slice(1).trim()))
      return
    }

    // ── 7. 普通段落 ───────────────────────────────────────
    this.writeLine(renderInline(line))
  }

  // ─── 输出方法（对标 PaiCLI writeLine / writeBlankLine） ──

  private writeLine(text: string): void {
    process.stdout.write(text + '\n')
    this.lastOutputBlank = false
    this.needsLineBreakBeforeNextBlock = true
    this.renderedRows += 1
  }

  private writeBlankLine(): void {
    if (!this.lastOutputBlank) {
      process.stdout.write('\n')
      this.lastOutputBlank = true
    }
    this.needsLineBreakBeforeNextBlock = false
  }

  /** 对标 PaiCLI ensureBlockSpacing */
  private ensureBlockSpacing(): void {
    if (this.needsLineBreakBeforeNextBlock && !this.lastOutputBlank) {
      process.stdout.write('\n')
      this.lastOutputBlank = true
    }
    this.needsLineBreakBeforeNextBlock = false
  }

  // ─── 表格处理 ──────────────────────────────────────────

  private looksLikeTableLine(trimmed: string): boolean {
    if (!trimmed) return false
    if (TABLE_SEPARATOR_RE.test(trimmed)) return true
    const pipeCount = (trimmed.match(/\|/g) || []).length
    return pipeCount >= 2
  }

  private flushPendingTable(): void {
    if (this.pendingTable.length === 0) return
    const lines = this.pendingTable
    this.pendingTable = []
    this.ensureBlockSpacing()
    const rendered = renderTable(lines)
    for (const line of rendered) {
      this.writeLine(line)
    }
    this.writeBlankLine()
  }

  // ─── 公共方法 ──────────────────────────────────────────

  /** 切换最后一个折叠块（Ctrl+O） */
  toggleLastBlock(): boolean {
    return this.blockRegistry.toggleLast()
  }

  /** 刷新行缓冲中残留的部分行（turn 结束时调用） */
  flush(): void {
    if (this.lineBuffer) {
      this.processLine(this.lineBuffer)
      this.lineBuffer = ''
    }
    this.flushPendingTable()
  }

  /** 新回合开始时重置 */
  reset(): void {
    this.lineBuffer = ''
    this.inCodeBlock = false
    this.codeLanguage = ''
    this.codeBodyLines = []
    this.codeFenceLine = ''
    this.pendingTable = []
    this.renderedRows = 0
    this.lastOutputBlank = false
    this.needsLineBreakBeforeNextBlock = false
  }

  /** 当前是否在代码块中 */
  isInCodeBlock(): boolean {
    return this.inCodeBlock
  }

  /** CJK 安全的显示宽度计算 */
  private displayWidth(text: string): number {
    let width = 0
    for (const char of text) {
      const code = char.codePointAt(0)!
      width += isWideChar(code) ? 2 : 1
    }
    return width
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
