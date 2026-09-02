// ui/foldable-block.ts — 可折叠块组件
// 对标 PaiCLI FoldableBlock.java
// 写入 stdout，支持 expand/collapse 原地切换（ANSI moveUp + clearToEos）

import { moveUp, CLEAR_TO_EOS } from './ansi.js'

export class FoldableBlock {
  private expanded = false
  private renderedLineCount = 0
  private frozen = false

  constructor(
    private readonly collapsedHeader: string,
    private readonly expandedLines: string[],
    private readonly collapseFooter: string = '⏷ collapse (ctrl+o)',
  ) {}

  /** 写折叠头到 stdout，标记 renderedLineCount=1 */
  renderInitial(): void {
    process.stdout.write(this.collapsedHeader + '\n')
    this.renderedLineCount = 1
  }

  /** 原地切换：moveUp + CLEAR_TO_EOS，然后重写内容。frozen 时返回 false */
  toggle(): boolean {
    if (this.frozen) return false

    // 清除已渲染的行
    if (this.renderedLineCount > 0) {
      process.stdout.write(moveUp(this.renderedLineCount) + '\r' + CLEAR_TO_EOS)
    }

    if (this.expanded) {
      // 切到折叠态
      process.stdout.write(this.collapsedHeader + '\n')
      this.renderedLineCount = 1
    } else {
      // 切到展开态
      for (const line of this.expandedLines) {
        process.stdout.write(line + '\n')
      }
      if (this.collapseFooter) {
        process.stdout.write(this.collapseFooter + '\n')
        this.renderedLineCount = this.expandedLines.length + 1
      } else {
        this.renderedLineCount = this.expandedLines.length
      }
    }

    this.expanded = !this.expanded
    return true
  }

  /** 仅翻转内存状态，不写终端（为 transcript redraw 准备） */
  toggleForRedraw(): boolean {
    if (this.frozen) return false
    this.expanded = !this.expanded
    this.renderedLineCount = this.currentLines().length
    return true
  }

  /** 返回当前态的行：折叠→[header]，展开→[...lines, footer] */
  currentLines(): string[] {
    if (!this.expanded) return [this.collapsedHeader]
    const lines = [...this.expandedLines]
    if (this.collapseFooter) lines.push(this.collapseFooter)
    return lines
  }

  /** 冻结后 toggle() 失效 */
  freeze(): void { this.frozen = true }

  isExpanded(): boolean { return this.expanded }
  isFrozen(): boolean { return this.frozen }
}
