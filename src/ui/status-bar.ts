// ui/status-bar.ts — 底部状态栏（2 行）
//
// 策略：不在顶部用 moveUp 覆写（会被模型输出拆开），
// 而是在回合结束后打印到当前光标位置（即输出末尾）。
// 状态栏随对话自然向下移动，始终紧跟在最后一条消息之后。

import { homedir } from 'node:os'
import { getTerminalSize, supportsAnsi } from './caps.js'

export interface StatusData {
  model: string
  phase: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  contextWindow: number
  totalTokens: number
  elapsedMs: number
  mode: string
  effort: string
  cwd: string
  skillCount: number
}

const CONTEXT_BAR_WIDTH = 8
const R = '\x1B[0m'
const WHITE = '\x1B[37m'
const BOLD = '\x1B[1m'
const DIM = '\x1B[2m'
const GRAY = '\x1B[90m'

function fmtTokens(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}k`
  return String(t)
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function compactCwd(cwd: string): string {
  if (!cwd) return ''
  const home = homedir()
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

function contextBar(total: number, window: number): string {
  const w = Math.max(1, window)
  const percent = Math.min(100, Math.round(total * 100 / w))
  const filled = Math.min(CONTEXT_BAR_WIDTH, Math.round(total * CONTEXT_BAR_WIDTH / w))
  const bar = '█'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled)
  return `ctx ${bar} ${percent}% (${fmtTokens(total)}/${fmtTokens(w)})`
}

export class StatusBar {
  private current: StatusData | null = null

  update(data: StatusData): void {
    this.current = data
  }

  currentStatus(): StatusData | null {
    return this.current
  }

  /**
   * 将状态栏打印到当前光标位置（输出末尾）。
   * 在回合结束后由 index.ts 调用。
   */
  print(): void {
    if (!supportsAnsi() || !this.current) return
    const data = this.current
    const cols = getTerminalSize().columns
    const line1 = this.formatLine1(data, cols)
    const line2 = this.formatLine2(data, cols)
    // 空行 + 状态栏 2 行，紧跟在模型输出之后
    process.stdout.write('\n' + line1 + '\n' + line2 + '\n')
  }

  /** 第 1 行：💬 normal  mimo-v2.5  6 tools · medium */
  private formatLine1(data: StatusData, cols: number): string {
    const icon = data.mode === 'plan' ? '📋' : data.mode === 'auto' ? '⚡' : '💬'
    const left = `${WHITE} ${icon} ${data.mode}  ${data.model}${R}`
    const right = `${DIM}${GRAY}${data.skillCount} tools · ${data.effort}${R}`
    // gap 最多 2 个空格，避免内部换行
    return left + '  ' + right
  }

  /** 第 2 行：✓ Ready  ctx █░░░░░░░ 5% (5k/100k)  ~/project */
  private formatLine2(data: StatusData, cols: number): string {
    const phaseLabel: Record<string, string> = {
      idle: '✓ Ready',
      thinking: '⏳ Thinking',
      tool: '🔧 Tool',
      streaming: '💬 Streaming',
    }
    let line = ` ${phaseLabel[data.phase] ?? data.phase}`
    line += `  ${contextBar(data.totalTokens, data.contextWindow)}`
    if (data.inputTokens > 0 || data.outputTokens > 0) {
      line += `  in ${fmtTokens(data.inputTokens)} out ${fmtTokens(data.outputTokens)}`
      if (data.cachedTokens > 0) line += ` cache ${fmtTokens(data.cachedTokens)}`
    }
    if (data.elapsedMs > 0) line += `  ${fmtElapsed(data.elapsedMs)}`
    line += `  ${compactCwd(data.cwd)}`
    return `${DIM}${GRAY}${line}${R}`
  }
}
