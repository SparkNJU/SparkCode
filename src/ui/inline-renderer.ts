import { BlockRegistry } from './block-registry.js'
import { FoldableBlock } from './foldable-block.js'
import { subtle } from './style.js'

/**
 * 流式渲染器 — 对标 PaiCLI InlineRenderer
 *
 * 逐 chunk 缓冲 → 逐行状态机：
 * - 检测 ``` 代码块头/尾
 * - 代码块内行缓冲，结束时创建 FoldableBlock
 * - 非代码块行直接 stdout 输出
 */
export class InlineRenderer {
  private blockRegistry: BlockRegistry
  private inCodeBlock = false
  private codeLanguage = ''
  private codeBodyLines: string[] = []
  private codeFenceLine = ''
  private lineBuffer = ''
  private renderedRows = 0

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
  private processLine(line: string): void {
    // 检测 ``` 代码块边界
    const codeFenceMatch = line.match(/^\s*```(\w*)/)

    if (!this.inCodeBlock && codeFenceMatch) {
      // 进入代码块
      this.inCodeBlock = true
      this.codeLanguage = codeFenceMatch[1] || ''
      this.codeFenceLine = line
      this.codeBodyLines = []
      return
    }

    if (this.inCodeBlock) {
      if (/^\s*```\s*$/.test(line)) {
        // 结束代码块 — 创建 FoldableBlock
        this.inCodeBlock = false
        const count = this.codeBodyLines.length
        const label = this.codeLanguage
          ? `code: ${this.codeLanguage}`
          : 'code'
        const header = subtle(`⏵ ${label} (${count} lines, ctrl+o to expand)`)
        const expanded = [this.codeFenceLine, ...this.codeBodyLines, line]
        const block = new FoldableBlock(header, expanded)
        this.blockRegistry.register(block)
        // 输出折叠头
        process.stdout.write(header + '\n')
        this.renderedRows += 1
        return
      }
      // 代码块内行 — 缓冲
      this.codeBodyLines.push(line)
      return
    }

    // 非代码块 — 直接输出
    process.stdout.write(line)
    this.renderedRows += 1
  }

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
  }

  /** 新回合开始时重置 */
  reset(): void {
    this.lineBuffer = ''
    this.inCodeBlock = false
    this.codeLanguage = ''
    this.codeBodyLines = []
    this.codeFenceLine = ''
    this.renderedRows = 0
  }

  /** 当前是否在代码块中 */
  isInCodeBlock(): boolean {
    return this.inCodeBlock
  }
}
