// ui/activity-display.ts — 思考/活动动画
// 对标 PaiCLI InlineActivityDisplay.java
//
// 功能：
// - Braille spinner（10 帧，250ms 刷新）
// - reasoning 预览（最多 4 行，│ 前缀）
// - 活动进度条（▰▱ + 渐近百分比）
// - ANSI moveUp + clearLine 原地重绘

import { moveUp, CLEAR_LINE } from './ansi.js'
import { getTerminalSize, supportsAnsi } from './caps.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_REASONING_ROWS = 4
const MAX_REASONING_CHARS = 4096
const SPINNER_INTERVAL_MS = 250

// ANSI 颜色常量（与 status-bar.ts 一致，不用 chalk 避免泄漏）
const R = '\x1B[0m'
const DIM = '\x1B[2m'
const GRAY = '\x1B[90m'
const CYAN = '\x1B[36m'
const YELLOW = '\x1B[33m'

export class ActivityDisplay {
  private frame = 0
  private reasoning = ''
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null
  private startMs = 0
  private label = 'Thinking'
  private showCancel = true
  private renderedRows = 0

  /** 开始思考动画（Braille spinner + reasoning 预览） */
  begin(label: string): void {
    this.clear()
    this.label = label || 'Thinking'
    this.showCancel = true
    this.reasoning = ''
    this.startMs = Date.now()
    this.frame = 0
    this.active = true
    this.render()
    this.timer = setInterval(() => {
      this.frame++
      this.render()
    }, SPINNER_INTERVAL_MS)
  }

  /** 追加 reasoning 内容（流式 delta） */
  appendThinking(delta: string): void {
    if (!this.active) {
      this.begin('Thinking')
    }
    this.reasoning += delta
    // 截断到最大字符数（保留尾部）
    if (this.reasoning.length > MAX_REASONING_CHARS) {
      this.reasoning = this.reasoning.slice(-MAX_REASONING_CHARS)
    }
    this.render()
  }

  /** 开始活动模式（进度条，无 reasoning） */
  beginActivity(label: string): void {
    this.clear()
    this.label = label || 'Working'
    this.showCancel = false
    this.reasoning = ''
    this.startMs = Date.now()
    this.frame = 0
    this.active = true
    this.render()
    this.timer = setInterval(() => {
      this.frame++
      this.render()
    }, SPINNER_INTERVAL_MS)
  }

  /** 结束动画，清除渲染行 */
  end(): void {
    this.active = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clearRendered()
    this.reasoning = ''
  }

  /** 清除当前动画状态（内部用） */
  private clear(): void {
    this.active = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clearRendered()
    this.reasoning = ''
  }

  /** 是否正在活跃 */
  isActive(): boolean {
    return this.active
  }

  /** 当前标签 */
  currentLabel(): string {
    return this.label
  }

  // ─── 渲染 ───

  private render(): void {
    if (!this.active || !supportsAnsi()) return
    this.clearRendered()

    const cols = Math.max(40, getTerminalSize().columns - 1)
    const lines: string[] = []

    if (this.showCancel) {
      // 思考模式：spinner + elapsed + reasoning 预览
      const elapsed = this.elapsedSec()
      const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
      lines.push(truncate(`  ${CYAN}${spinner}${R} ${DIM}${this.label}... (esc to cancel, ${elapsed}s)${R}`, cols))

      // reasoning 预览（最多 4 行，取最后几行）
      if (this.reasoning.trim()) {
        const reasoningLines = this.reasoning.split(/\n/).filter(l => l.trim()).slice(-MAX_REASONING_ROWS)
        for (const line of reasoningLines) {
          lines.push(truncate(`  ${DIM}${GRAY}│ ${line.trim()}${R}`, cols))
        }
      }
    } else {
      // 活动模式：进度条
      const progress = this.progressPercent()
      const barWidth = Math.max(10, Math.min(40, cols - 20))
      const filled = Math.max(1, Math.round(barWidth * progress / 100))
      const bar = '▰'.repeat(filled) + '▱'.repeat(barWidth - filled)
      lines.push(`  ${YELLOW}✢${R} ${DIM}${this.label}...${R}`)
      lines.push(`    ${CYAN}${bar}${R} ${DIM}${progress}%${R}`)
    }

    process.stderr.write(lines.join('\n') + '\n')
    this.renderedRows = lines.length
  }

  private clearRendered(): void {
    if (this.renderedRows <= 0 || !process.stderr.isTTY) return
    for (let i = 0; i < this.renderedRows; i++) {
      process.stderr.write(moveUp(1) + CLEAR_LINE)
    }
    // 写入全量重置，清除 stderr 残留的 dim/gray 样式
    // 防止泄漏到后续 stdout 输出（stderr 和 stdout 共享终端 ANSI 状态）
    process.stderr.write('\x1B[0m')
    this.renderedRows = 0
  }

  private elapsedSec(): number {
    return Math.max(0, Math.round((Date.now() - this.startMs) / 1000))
  }

  /** 渐近进度百分比（对标 PaiCLI 的曲线） */
  private progressPercent(): number {
    const elapsed = Date.now() - this.startMs
    const curve = 1.0 - Math.exp(-elapsed / 15000.0)
    return Math.max(1, Math.min(95, Math.round(curve * 95)))
  }
}

/** 截断字符串到指定宽度（ANSI 安全） */
function truncate(text: string, maxWidth: number): string {
  let visibleWidth = 0
  let inEscape = false
  let result = ''

  for (const ch of text) {
    if (ch === '\x1B') {
      inEscape = true
      result += ch
      continue
    }
    if (inEscape) {
      result += ch
      if (ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z') {
        inEscape = false
      }
      continue
    }
    // 普通字符
    const code = ch.codePointAt(0)!
    const w = isWideChar(code) ? 2 : 1
    if (visibleWidth + w > maxWidth - 3) {
      result += '...'
      break
    }
    visibleWidth += w
    result += ch
  }
  return result
}

function isWideChar(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0x3000 && cp <= 0x303F)
    || (cp >= 0xFF01 && cp <= 0xFF60)
    || (cp >= 0x3040 && cp <= 0x309F)
    || (cp >= 0x30A0 && cp <= 0x30FF)
    || (cp >= 0x1F300 && cp <= 0x1FAFF)
}
