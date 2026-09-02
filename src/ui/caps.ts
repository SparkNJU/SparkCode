// ui/caps.ts — 终端能力检测
// 对标 PaiCLI TerminalCapabilities.java

export interface TerminalSize {
  columns: number
  rows: number
}

/** 获取终端尺寸，不可用时返回 80×24 */
export function getTerminalSize(): TerminalSize {
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  return { columns: Math.max(20, cols), rows: Math.max(5, rows) }
}

/** 是否支持 ANSI 转义序列 */
export function supportsAnsi(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.TERM === 'dumb') return false
  return !!process.stdout.isTTY
}

/** 是否支持真彩色 */
export function supportsTrueColor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit'
}

/** 是否支持状态栏（需要 TTY + ANSI） */
export function supportsStatusBar(): boolean {
  return supportsAnsi() && !!process.stdout.isTTY && getTerminalSize().rows >= 5
}
