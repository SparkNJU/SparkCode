// ui/banner.ts — 欢迎屏幕（SPARK ASCII art）
//
// 样式策略：只给 S 色块加紫色，其余全部纯文本。
// 每个样式段用 \x1B[0m 完全重置，防止泄漏。

export interface BannerInfo {
  model: string
  skills: number
  mode: string
  version: string
  cwd: string
  sessionId: string
}

/** 紫色粗体（用于 S 色块） */
function purple(s: string): string {
  return `\x1B[1m\x1B[38;2;139;92;246m${s}\x1B[0m`
}

export function buildBannerLines(info: BannerInfo): string[] {
  return [
    '',
    `   ${purple('███████╗')}     Spark Code  v${info.version}`,
    `   ${purple('██╔════╝')}     Model ${info.model}`,
    `   ${purple('███████╗')}     ${info.skills} tools · ${info.mode}`,
    `   ${purple('╚════██║')}     Tools · Memory · Skills · Modes`,
    `   ${purple('███████║')}     ${info.cwd}`,
    `   ${purple('╚══════╝')}`,
    '',
    'Tips for getting started:',
    '1. Type / for commands and Tab completion',
    '2. Ask coding questions, edit code or run commands',
    '3. Type /help for all available commands',
    '',
  ]
}

export function printBanner(info: BannerInfo): void {
  process.stdout.write(buildBannerLines(info).join('\n') + '\n')
}
