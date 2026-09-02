// ui/ansi.ts — ANSI 常量与光标控制
// 对标 PaiCLI AnsiSeq.java

const ESC = '\x1B'

// 光标移动
export const moveUp = (n: number): string => `${ESC}[${n}A`
export const moveDown = (n: number): string => `${ESC}[${n}B`
export const moveCol = (col: number): string => `${ESC}[${col}G`

// 清除
export const CLEAR_LINE = `${ESC}[2K`
export const CLEAR_TO_EOL = `${ESC}[K`
export const CLEAR_TO_EOS = `${ESC}[J`

// 光标可见性
export const HIDE_CURSOR = `${ESC}[?25l`
export const SHOW_CURSOR = `${ESC}[?25h`

// 保存/恢复光标位置（用于状态栏）
export const SAVE_CURSOR = `${ESC}7`
export const RESTORE_CURSOR = `${ESC}8`

// Bracketed paste
export const PASTE_START = `${ESC}[200~`
export const PASTE_END = `${ESC}[201~`
