// ui/index.ts — UI 模块入口

export { createCompleter } from './completer.js'
export { buildPrompt } from './prompt.js'
export { moveUp, moveDown, moveCol, CLEAR_LINE, CLEAR_TO_EOL, CLEAR_TO_EOS, HIDE_CURSOR, SHOW_CURSOR, SAVE_CURSOR, RESTORE_CURSOR, PASTE_START, PASTE_END } from './ansi.js'
export { getTerminalSize, supportsAnsi, supportsTrueColor, supportsStatusBar, type TerminalSize } from './caps.js'
export { heading, section, subtle, thinking, codeLabel, error, emphasis, quotePrefix, success, warn, userMessageBlock, displayWidth, stripAnsi } from './style.js'
export { StatusBar, type StatusData } from './status-bar.js'
export { printBanner, type BannerInfo } from './banner.js'
export { ActivityDisplay } from './activity-display.js'
