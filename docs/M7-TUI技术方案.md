# M7 — TUI 终端界面技术方案

> 参考项目：PaiCLI（Java / JLine + Lanterna）
> 实现语言：TypeScript / Node.js
> 核心思路：**严格对齐 PaiCLI 的 Inline 模式**，用 ANSI Escape Codes + `chalk` 替代 JLine Status / Lanterna

---

## 0. 设计目标

PaiCLI 有三种渲染模式（`RendererFactory.Mode`）：

| 模式 | PaiCLI 实现 | SparkCode 对应 |
|------|------------|---------------|
| **INLINE**（默认） | JLine Status + InlineRenderer | ✅ M7 实现（主模式） |
| LANTERNA（全屏） | Lanterna 三方库 | ❌ 暂不实现 |
| PLAIN（纯文本） | System.out.println | ✅ 已有（printMode） |

**M7 只实现 INLINE 模式**，与 PaiCLI 默认行为完全一致：
- 欢迎界面 = SPARK ASCII art（紫色 S 色块）+ 信息行
- 顶部状态栏 = 固定 2 行（model、mode、effort、context bar、cwd），原地覆写不漂移
- 流式输出 = 内容在状态栏下方滚动
- 思考动画 = Braille spinner + reasoning 预览
- 工具调用 = 可折叠块（`⏵` / `⏷`）
- 代码块 = 自动折叠 + Ctrl+O 展开
- Markdown = 终端渲染（标题、粗体、代码块、表格）
- 输入高亮 = slash 命令着色

---

## 1. 技术选型

### PaiCLI → SparkCode 映射

| PaiCLI (Java) | SparkCode (TypeScript) | 说明 |
|---|---|---|
| `org.jline.reader.LineReader` | `node:readline/promises` | 已有，继续使用 |
| `org.jline.utils.Status` | 自研 `StatusBar`（ANSI escape） | 保留/恢复光标 + 底部写入 |
| `AnsiStyle` | `chalk` (npm) | 终端颜色库 |
| `InlineRenderer` | 自研 `InlineRenderer` | 流式输出 + 代码块折叠 |
| `InlineActivityDisplay` | 自研 `ActivityDisplay` | Braille spinner + reasoning |
| `BottomStatusBar` | 自研 `StatusBar` | 2 行 dock |
| `FoldableBlock` | 自研 `FoldableBlock` | 可折叠块 |
| `ToolCallRenderer` | 自研 `ToolCallRenderer` | 工具调用格式化 |
| `TerminalMarkdownRenderer` | 自研 `MarkdownRenderer` | Markdown → ANSI |
| `BlockRegistry` | 自研 `BlockRegistry` | 折叠块注册表 |
| `AnsiSeq` | 自研 `ansi.ts` | ANSI 常量 |
| `TerminalCapabilities` | 自研 `TerminalCaps` | 终端能力检测 |
| `PaiCliHighlighter` | 自研 `InputHighlighter` | 输入语法高亮 |
| `PaiCliCompleter` | 已有 `completer.ts` | Tab 补全 |
| `PaiCliHistory` | `~/.spark/history` | 命令历史持久化 |

### 新增依赖

```json
{
  "dependencies": {
    "chalk": "^5.4.1"        // 终端颜色（替代手动 ANSI code）
  }
}
```

> 不引入 `blessed` / `ink` / `blessed-contrib` 等重 TUI 框架。
> PaiCLI 的 inline 模式也不依赖 Lanterna（Lanterna 仅用于全屏模式），
> 我们用纯 ANSI 实现同等效果。

---

## 2. 模块结构

```
src/ui/
├── index.ts                   # 模块入口（导出）
├── ansi.ts                    # ANSI 常量 + 光标控制（对标 AnsiSeq）
├── caps.ts                    # 终端能力检测（对标 TerminalCapabilities）
├── style.ts                   # 样式辅助（对标 AnsiStyle，基于 chalk）
├── banner.ts                  # 欢迎屏幕（SPARK ASCII art）
├── status-bar.ts              # 底部状态栏（对标 BottomStatusBar）
├── activity-display.ts        # 思考/活动动画（对标 InlineActivityDisplay）
├── inline-renderer.ts         # 流式渲染器（对标 InlineRenderer）
├── foldable-block.ts          # 可折叠块（对标 FoldableBlock）
├── block-registry.ts          # 折叠块注册表（对标 BlockRegistry）
├── tool-call-renderer.ts      # 工具调用渲染（对标 ToolCallRenderer）
├── markdown.ts                # Markdown 终端渲染（对标 TerminalMarkdownRenderer）
├── input-highlighter.ts       # 输入高亮（对标 PaiCliHighlighter）
├── completer.ts               # Tab 补全（已有）
├── prompt.ts                  # 动态提示符（已有）
└── history.ts                 # 命令历史持久化（新增）
```

---

## 3. 详细设计

### 3.0 ANSI 样式隔离规则（核心设计约束）

**问题**：stderr 和 stdout 共享同一个终端的 ANSI 状态机。某个流设置的样式属性（粗体、暗淡、颜色）会影响另一个流的后续输出，除非被显式重置。

**已知陷阱**：

| 陷阱 | 原因 | 表现 |
|------|------|------|
| chalk 选择性重置 | `chalk.dim.gray('x')` 生成 `\x1B[2m\x1B[90mx\x1B[22m\x1B[39m`，`\x1B[22m` 只关闭 dim，`\x1B[39m` 只关闭前景色 | 后续无样式文本仍继承其他属性（如背景色、粗体） |
| stderr 样式泄漏到 stdout | ActivityDisplay 向 stderr 写入 dim+gray，清除后终端 ANSI 状态仍残留 | 模型正文内容变成灰色 |
| 部分重置不完整 | `\x1B[22m`（关 dim）+ `\x1B[39m`（关颜色）≠ `\x1B[0m`（全量重置） | 样式残留累积 |

**正确规则（所有 TUI 模块必须遵守）**：

1. **禁止使用 chalk**：chalk 生成选择性重置（`\x1B[22m`、`\x1B[39m`），不完全清除样式状态。所有样式必须用原始 ANSI 转义序列 + `\x1B[0m` 全量重置。

2. **每个样式段必须闭合**：任何设置了样式的代码段，必须在段末写入 `\x1B[0m`。
   ```
   ✅ \x1B[2m\x1B[90m灰色文本\x1B[0m
   ❌ \x1B[2m\x1B[90m灰色文本      ← 样式泄漏
   ```

3. **stderr 写入后必须重置**：写入 stderr 的带样式内容，在最后一次写入时必须以 `\x1B[0m` 结尾。因为接下来 stdout 会继续写入，终端的 ANSI 状态是共享的。
   ```typescript
   // ActivityDisplay.clearRendered() 示例
   process.stderr.write(moveUp(1) + CLEAR_LINE)  // 清除行
   process.stderr.write('\x1B[0m')                // 重置，防止泄漏到 stdout
   ```

4. **stdout 写入前可防御性重置**：从 styled 切换到 unstyled 时，在 stdout 写入前加 `\x1B[0m`。
   ```typescript
   // 从 stderr 动画切换到 stdout 正文
   activityDisplay.end()  // 内部已写 \x1B[0m
   stdout.write(content)  // 正文不会继承灰色
   ```

5. **状态栏 / 动画等临时样式组件，必须实现 cleanup**：任何写入 stderr 的带样式组件（StatusBar、ActivityDisplay），必须有 `end()` / `clear()` 方法，清除已渲染行并写入 `\x1B[0m`。

6. **常量定义**：在 `status-bar.ts` / `activity-display.ts` 顶部定义颜色常量，每个段末尾显式使用 `R`（`\x1B[0m`）闭合。
   ```typescript
   const R = '\x1B[0m'       // 全量重置（唯一可信的重置方式）
   const DIM = '\x1B[2m'
   const GRAY = '\x1B[90m'
   const BOLD = '\x1B[1m'
   const CYAN = '\x1B[36m'
   // 用法：`${DIM}${GRAY}文本${R}`  ← 段末必闭合
   ```

### 3.1 `ansi.ts` — ANSI 常量与光标控制

对标 PaiCLI 的 `AnsiSeq.java`：

```typescript
// src/ui/ansi.ts

export const ESC = '\x1B'

// 光标移动
export const moveUp = (n: number) => `${ESC}[${n}A`
export const moveDown = (n: number) => `${ESC}[${n}B`
export const moveCol = (col: number) => `${ESC}[${col}G`   // 移到指定列

// 清除
export const CLEAR_LINE = `${ESC}[2K`                       // 清当前行
export const CLEAR_TO_EOL = `${ESC}[K`                      // 清到行尾
export const CLEAR_TO_EOS = `${ESC}[J`                      // 清到屏幕底

// 光标可见性
export const HIDE_CURSOR = `${ESC}[?25l`
export const SHOW_CURSOR = `${ESC}[?25h`

// 保存/恢复光标位置（用于状态栏）
export const SAVE_CURSOR = `${ESC}7`
export const RESTORE_CURSOR = `${ESC}8`

// Bracketed paste 检测
export const PASTE_START = `${ESC}[200~`
export const PASTE_END = `${ESC}[201~`
```

### 3.2 `caps.ts` — 终端能力检测

对标 `TerminalCapabilities.java`：

```typescript
// src/ui/caps.ts

export interface TerminalSize {
  columns: number
  rows: number
}

export function getTerminalSize(): TerminalSize {
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  return { columns: Math.max(20, cols), rows: Math.max(5, rows) }
}

export function supportsAnsi(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  return !!process.stdout.isTTY
}

export function supportsTrueColor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit'
}
```

### 3.3 `style.ts` — 样式辅助

对标 `AnsiStyle.java`，基于 `chalk` 实现：

```typescript
// src/ui/style.ts
import chalk from 'chalk'

const enabled = supportsAnsi()

export const style = {
  heading: (t: string) => enabled ? chalk.bold.cyan(t) : t,
  section: (t: string) => enabled ? chalk.bold.green(t) : t,
  subtle:  (t: string) => enabled ? chalk.dim.gray(t) : t,
  thinking:(t: string) => enabled ? chalk.italic.gray(t) : t,
  codeLabel:(t: string) => enabled ? chalk.bold.yellow(t) : t,
  error:   (t: string) => enabled ? chalk.bold.red(t) : t,
  emphasis:(t: string) => enabled ? chalk.bold(t) : t,
  quotePrefix:(t: string) => enabled ? chalk.dim.cyan(t) : t,
  success: (t: string) => enabled ? chalk.green(t) : t,
  warn:    (t: string) => enabled ? chalk.yellow(t) : t,
}

/** 用户消息块（紫色前缀 + 背景色）— 对标 AnsiStyle.userMessageBlock */
export function userMessageBlock(text: string, columns: number): string {
  const lines = text.split('\n')
  return lines.map(line => {
    const prefix = '> '
    const content = prefix + line
    const padding = Math.max(0, columns - displayWidth(content))
    if (!enabled) return content + ' '.repeat(padding)
    return chalk.bgRgb(50, 50, 50).hex('#8B5CF6')(prefix) +
           chalk.bgRgb(50, 50, 50)(line) +
           chalk.bgRgb(50, 50, 50)(' '.repeat(padding))
  }).join('\n')
}

/** CJK 安全的显示宽度计算 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    width += isWideChar(code) ? 2 : 1
  }
  return width
}

function isWideChar(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF)    // CJK
      || (cp >= 0x3000 && cp <= 0x303F)    // CJK Symbols
      || (cp >= 0xFF01 && cp <= 0xFF60)    // Fullwidth
      || (cp >= 0x3040 && cp <= 0x309F)    // Hiragana
      || (cp >= 0x30A0 && cp <= 0x30FF)    // Katakana
      || (cp >= 0x1F300 && cp <= 0x1FAFF)  // Emoji
}
```

### 3.4 `banner.ts` — 欢迎屏幕

对标 PaiCLI `Main.startupBannerLines()`。SPARK ASCII art：

```typescript
// src/ui/banner.ts
import chalk from 'chalk'

export interface BannerInfo {
  model: string
  provider: string
  skills: number
  mode: string
  version: string
}

export function buildBannerLines(info: BannerInfo): string[] {
  const green = chalk.bold.green
  const bold = chalk.bold
  const dim = chalk.dim.gray

  const ready = `Model ${info.model} (${info.provider})`
  const state = `${info.skills} skills · ${info.mode}`
  const capabilities = 'Tools · Memory · Skills · Mode Switch'

  return [
    '',
    '   ' + green('████████████████╗') + '     ' + bold('Spark Code') + '  ' + dim('v' + info.version),
    '   ' + green('██╔═════════════╝') + '     ' + dim(ready),
    '   ' + green('██║') + '  ' + green('█████╗') + '  ' + green('█████╗') + '     ' + dim(state),
    '   ' + green('██║') + ' ' + green('██╔══██╗') + green('██╔══██╗') + '    ' + dim(capabilities),
    '   ' + green('██║') + ' ' + green('███████║') + green('███████║'),
    '   ' + green('██║') + ' ' + green('██╔══██║') + green('██╔══██║'),
    '   ' + green('██║') + ' ' + green('██║  ██║') + green('██║  ██║'),
    '   ' + green('╚═╝') + ' ' + green('╚═╝  ╚═╝') + green('╚═╝  ╚═╝'),
    '',
    'Tips for getting started:',
    '1. Type ' + bold('/') + ' for commands and Tab completion',
    '2. Ask coding questions, edit code or run commands',
    '3. Type ' + bold('/help') + ' for all available commands',
    '',
  ]
}
```

**输出方式**：对标 PaiCLI 的 `InlineRenderer.installStartupScreen()` ——
在 readline 第一次 `readLine` 之前用 `process.stdout.write()` 输出。
不使用 `printAbove`（因为此时 LineReader 尚未开始读取）。

### 3.5 `status-bar.ts` — 顶部状态栏（核心）

~~原方案用底部 dock（对标 PaiCLI BottomStatusBar），但 ANSI save/restore cursor 在内容滚动后光标漂移，改为顶部状态栏。~~

**设计**：状态栏固定在终端最顶部，内容在下方滚动。
- 启动时 `initialRender()` 写入 2 行
- 状态变化时 `update()` 用 ANSI `moveUp + clearLine` 原地覆写
- 不需要 `hide()`（退出时自然留在顶部）

```typescript
// src/ui/status-bar.ts

export interface StatusData {
  model: string
  phase: string              // 'idle' | 'thinking' | 'tool' | 'streaming'
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  contextWindow: number
  totalTokens: number
  elapsedMs: number
  mode: string               // 'normal' | 'plan' | 'auto'
  effort: string             // 'low' | 'medium' | 'high'
  cwd: string
  skillCount: number
}

export class StatusBar {
  private current: StatusData | null = null
  private renderedLineCount = 0

  /** 首次渲染（写入 2 行到 stdout） */
  initialRender(data: StatusData): void { ... }

  /** 原地覆写已渲染的行 */
  update(data: StatusData): void { ... }
}
```
```

**与 PaiCLI 对比**：

| PaiCLI BottomStatusBar | SparkCode StatusBar |
|---|---|
| `Status.getStatus(terminal)` 创建 dock | 手动 ANSI save/restore cursor |
| `status.setBorder(true)` 画边框 | 不画边框（更简洁） |
| 2 行：statusLine + footerLine | 2 行：line1 + line2 |
| `formatStatusLine`: HITL indicator + MCP/skills | `formatLine1`: mode + skills + effort |
| `formatFooterLine`: model + phase + ctx bar + tokens + cost + cwd | `formatLine2`: model + phase + ctx bar + tokens + elapsed + cwd |
| `contextSegment`: 8 字符 `█░` 进度条 | `contextBar`: 同样 8 字符 `█░` |
| `formatTokens`: ≥1M → X.XM, ≥1K → X.Xk | `fmtTokens`: 同样规则 |

### 3.6 `activity-display.ts` — 思考/活动动画

对标 `InlineActivityDisplay.java`：

```typescript
// src/ui/activity-display.ts

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_REASONING_ROWS = 4
const MAX_REASONING_CHARS = 4096

export class ActivityDisplay {
  private frame = 0
  private reasoning = ''
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null
  private startNanos = 0n
  private label = 'Thinking'
  private showCancel = true
  private renderedRows = 0

  begin(label: string): void {
    this.clear()
    this.label = label || 'Thinking'
    this.showCancel = true
    this.reasoning = ''
    this.startNanos = process.hrtime.bigint()
    this.frame = 0
    this.active = true
    this.render()
    this.timer = setInterval(() => { this.frame++; this.render() }, 250)
  }

  appendThinking(delta: string): void {
    if (!this.active) {
      this.begin('Thinking')
    }
    this.reasoning += delta
    if (this.reasoning.length > MAX_REASONING_CHARS) {
      this.reasoning = this.reasoning.slice(-MAX_REASONING_CHARS)
    }
    this.render()
  }

  beginActivity(label: string): void {
    this.clear()
    this.label = label || 'Working'
    this.showCancel = false
    this.reasoning = ''
    this.startNanos = process.hrtime.bigint()
    this.frame = 0
    this.active = true
    this.render()
    this.timer = setInterval(() => { this.frame++; this.render() }, 250)
  }

  end(): void {
    this.active = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.clearRendered()
    this.reasoning = ''
  }

  private render(): void {
    if (!this.active || !process.stdout.isTTY) return
    this.clearRendered()
    const cols = getTerminalSize().columns - 1
    const lines: string[] = []

    if (this.showCancel) {
      const elapsed = this.elapsedSec()
      const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
      lines.push(truncate(`  ${spinner} ${this.label}... (esc to cancel, ${elapsed}s)`, cols))
      // 推理内容预览（最多 4 行）
      const reasoningLines = this.reasoning.split(/\n/).filter(l => l.trim()).slice(-MAX_REASONING_ROWS)
      for (const line of reasoningLines) {
        lines.push(truncate(`  │ ${line.trim()}`, cols))
      }
    } else {
      // 活动模式（进度条）
      const progress = this.progressPercent()
      const barWidth = Math.max(10, Math.min(40, cols - 12))
      const filled = Math.max(1, Math.round(barWidth * progress / 100))
      const bar = '▰'.repeat(filled) + '▱'.repeat(barWidth - filled)
      lines.push(`  ✢ ${this.label}...`)
      lines.push(`    ${bar} ${progress}%`)
    }

    // 写到 stderr（不干扰 stdout 流式输出）
    process.stderr.write(lines.join('\n') + '\n')
    this.renderedRows = lines.length
  }

  private clearRendered(): void {
    if (this.renderedRows <= 0 || !process.stderr.isTTY) return
    for (let i = 0; i < this.renderedRows; i++) {
      process.stderr.write(moveUp(1) + CLEAR_LINE)
    }
    this.renderedRows = 0
  }

  private elapsedSec(): number {
    return Number((process.hrtime.bigint() - this.startNanos) / 1_000_000_000n)
  }

  private progressPercent(): number {
    const elapsed = Number((process.hrtime.bigint() - this.startNanos) / 1_000_000n)
    const curve = 1.0 - Math.exp(-elapsed / 15000.0)
    return Math.max(1, Math.min(95, Math.round(curve * 95)))
  }
}
```

**与 PaiCLI 对比**：

| PaiCLI InlineActivityDisplay | SparkCode ActivityDisplay |
|---|---|
| Braille spinner `⠋⠙⠹...` | 同样 10 帧 Braille spinner |
| 250ms 刷新间隔 | 同样 250ms |
| 4 行 reasoning 预览 + `│` 前缀 | 同样 4 行 + `│` 前缀 |
| `esc to cancel, Ns` 提示 | 同样提示 |
| 进度条 `▰▱` + 渐近百分比 | 同样进度条 + 同样算法 |
| ANSI moveUp + clearLine 重绘 | 同样方式 |
| 用 `PrintStream` 写终端 | 用 `process.stderr.write` |

### 3.7 `foldable-block.ts` — 可折叠块

对标 `FoldableBlock.java`：

```typescript
// src/ui/foldable-block.ts

export class FoldableBlock {
  private expanded = false
  private renderedLines = 0
  private frozen = false

  constructor(
    private collapsedHeader: string,
    private expandedLines: string[],
    private collapseFooter: string = '⏷ collapse (ctrl+o)',
  ) {}

  renderCollapsed(): void {
    process.stdout.write(this.collapsedHeader + '\n')
    this.renderedLines = 1
  }

  toggle(): boolean {
    if (this.frozen) return false
    // 清除已渲染行
    for (let i = 0; i < this.renderedLines; i++) {
      process.stdout.write(moveUp(1) + CLEAR_LINE)
    }
    process.stdout.write('\r' + CLEAR_TO_EOS)

    if (this.expanded) {
      process.stdout.write(this.collapsedHeader + '\n')
      this.renderedLines = 1
    } else {
      for (const line of this.expandedLines) {
        process.stdout.write(line + '\n')
      }
      if (this.collapseFooter) {
        process.stdout.write(this.collapseFooter + '\n')
        this.renderedLines = this.expandedLines.length + 1
      } else {
        this.renderedLines = this.expandedLines.length
      }
    }
    this.expanded = !this.expanded
    return true
  }

  currentLines(): string[] {
    if (!this.expanded) return [this.collapsedHeader]
    return [...this.expandedLines, this.collapseFooter]
  }

  freeze(): void { this.frozen = true }
  isExpanded(): boolean { return this.expanded }
}
```

### 3.8 `tool-call-renderer.ts` — 工具调用渲染

对标 `ToolCallRenderer.java`：

```typescript
// src/ui/tool-call-renderer.ts

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export function groupToolCalls(calls: ToolCall[]): Map<string, ToolCall[]> {
  const grouped = new Map<string, ToolCall[]>()
  for (const tc of calls) {
    const list = grouped.get(tc.name) || []
    list.push(tc)
    grouped.set(tc.name, list)
  }
  return grouped
}

export function collapsedHeader(grouped: Map<string, ToolCall[]>): string {
  if (grouped.size === 1) {
    const [name, calls] = [...grouped.entries()][0]
    return style.subtle(`⏵ ${toolLabel(name, calls.length)} (ctrl+o to expand)`)
  }
  const total = [...grouped.values()].reduce((s, c) => s + c.length, 0)
  return style.subtle(`⏵ ${grouped.size} groups / ${total} calls (ctrl+o to expand)`)
}

export function expandedLines(grouped: Map<string, ToolCall[]>): string[] {
  const lines: string[] = []
  for (const [name, calls] of grouped) {
    lines.push(style.subtle(`  ${toolLabel(name, calls.length)}`))
    for (const tc of calls) {
      const detail = extractKeyParam(name, tc.arguments)
      if (detail) lines.push(style.subtle(`    └ ${detail}`))
    }
  }
  return lines
}

function toolLabel(name: string, count: number): string {
  const icons: Record<string, string> = {
    bash: '⚡', read: '📖', write: '✏️', edit: '✏️',
    glob: '📂', grep: '🔍', web_fetch: '📰', web_search: '🌐',
  }
  const icon = icons[name] || '🔧'
  return `${icon} ${name}` + (count > 1 ? ` × ${count}` : '')
}

function extractKeyParam(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson)
    const keys: Record<string, string> = {
      bash: 'command', read: 'path', write: 'path', edit: 'path',
      glob: 'pattern', grep: 'pattern', web_fetch: 'url', web_search: 'query',
    }
    const key = keys[name]
    const value = key ? args[key] : undefined
    if (value && typeof value === 'string') {
      return value.length > 80 ? value.slice(0, 77) + '...' : value
    }
    return ''
  } catch { return '' }
}
```

### 3.9 `inline-renderer.ts` — 流式渲染器（核心）

对标 `InlineRenderer.java`，这是整个 TUI 的核心组件。

**PaiCLI InlineRenderer 的关键机制**：
1. 用 `OutputStream` 包装 `PrintStream`，逐字符检测代码块边界
2. 检测到 `┌─ code` 时进入折叠状态机，缓冲 body 行
3. 检测到 `└─ end` 时用 ANSI moveUp 覆盖 header，渲染折叠头
4. 非代码块行直接写入（通过 `printAbove` 或 stdout）
5. 维护 `transcript` 列表支持 Ctrl+O 重绘

```typescript
// src/ui/inline-renderer.ts

export class InlineRenderer {
  private transcript: TranscriptEntry[] = []
  private renderedRows = 0
  private inCodeBlock = false
  private codeLanguage = ''
  private codeBodyLines: string[] = []
  private codeHeaderLine = ''
  private lineBuffer = ''
  private blockRegistry: BlockRegistry

  constructor(
    private statusBar: StatusBar,
    private activityDisplay: ActivityDisplay,
  ) {
    this.blockRegistry = new BlockRegistry()
  }

  /** 流式写入一个 chunk（对标 createTranscriptStream.write） */
  write(text: string): void {
    for (const ch of text) {
      this.lineBuffer += ch
      if (ch === '\n') {
        this.processLine(this.lineBuffer)
        this.lineBuffer = ''
      }
    }
  }

  private processLine(line: string): void {
    const stripped = stripAnsi(line).trim()

    // 代码块折叠状态机（与 PaiCLI 完全一致）
    if (!this.inCodeBlock && stripped.startsWith('┌─ code')) {
      this.inCodeBlock = true
      const colon = stripped.indexOf(':')
      this.codeLanguage = colon >= 0 ? stripped.slice(colon + 1).trim() : ''
      this.codeHeaderLine = line
      this.codeBodyLines = []
      this.emit(line)
      this.transcript.push({ type: 'text', text: line })
      this.renderedRows += estimateRows(line)
      return
    }

    if (this.inCodeBlock) {
      if (stripped.startsWith('└─ end')) {
        this.inCodeBlock = false
        const count = this.codeBodyLines.length
        // 覆盖 header
        this.clearLastLine()
        const label = this.codeLanguage ? `code: ${this.codeLanguage}` : 'code'
        const header = style.subtle(`⏵ ${label} (${count} lines, ctrl+o to expand)`)
        const expanded = [this.codeHeaderLine, ...this.codeBodyLines, line]
        const block = new FoldableBlock(header, expanded)
        this.blockRegistry.register(block)
        process.stdout.write(header + '\n')
        return
      }
      this.codeBodyLines.push(line)
      return
    }

    // 普通行
    this.emit(line)
    this.transcript.push({ type: 'text', text: line })
    this.renderedRows += estimateRows(line)
  }

  private emit(text: string): void {
    process.stdout.write(text)
  }

  private clearLastLine(): void {
    process.stdout.write(moveUp(1) + '\r' + CLEAR_TO_EOL)
  }

  /** Ctrl+O：切换最后一个折叠块 */
  toggleLastBlock(): boolean {
    return this.blockRegistry.toggleLast()
  }

  /** 清除已接受的输入行（对标 clearAcceptedInput） */
  clearAcceptedInput(input: string): void {
    const rows = estimateRows(input) + 1
    for (let i = 0; i < rows; i++) {
      process.stdout.write(moveUp(1) + CLEAR_LINE)
    }
  }

  /** 打印用户提交的消息块（对标 printSubmittedPrompt） */
  printUserMessage(input: string): void {
    const cols = getTerminalSize().columns
    process.stdout.write(userMessageBlock(input, cols) + '\n')
  }

  /** 新回合开始 */
  beginTurn(): void {
    this.transcript = []
    this.renderedRows = 0
    this.lineBuffer = ''
    this.inCodeBlock = false
    this.codeBodyLines = []
  }
}

type TranscriptEntry =
  | { type: 'text'; text: string }
  | { type: 'block'; block: FoldableBlock }
```

### 3.10 `markdown.ts` — Markdown 终端渲染

对标 `TerminalMarkdownRenderer.java`：

```typescript
// src/ui/markdown.ts

/**
 * 流式 Markdown → ANSI 渲染器
 * 对标 PaiCLI 的 TerminalMarkdownRenderer
 *
 * 支持：
 * - # 标题（粗体 + 下划线）
 * - **粗体** / *斜体*
 * - `行内代码`（反色）
 * - ``` 代码块 ```（带语言标签 + 边框）
 * - > 引用（dim cyan 前缀）
 * - 表格（边框 + 单元格换行）
 * - 有序/无序列表
 */
export function renderMarkdown(text: string): string {
  // 实现细节见 §3.10 详述
}
```

**渲染规则**（与 PaiCLI `TerminalMarkdownRenderer` 对齐）：

| 元素 | PaiCLI 渲染 | SparkCode 渲染 |
|------|------------|---------------|
| `# Heading` | BOLD + underline | `chalk.bold.underline` |
| `**bold**` | BOLD | `chalk.bold` |
| `` `code` `` | codeLabel (BOLD+YELLOW) | `chalk.bold.yellow` |
| ``` ```lang | `┌─ code: lang` 边框 | 同左 |
| ``` end | `└─ end` 边框 | 同左 |
| `> quote` | quotePrefix (DIM+CYAN) + content | `chalk.dim.cyan('│ ')` + content |
| `- item` | `•` + indent | `•` + indent |
| `1. item` | number + `.` + indent | number + `.` + indent |
| table | 边框 `┌┬┐├┼┤└┴┘` + cell wrap | 同左 |

### 3.11 `input-highlighter.ts` — 输入高亮

对标 `PaiCliHighlighter.java`。在 readline 的 `completer` 回调之外，
利用 readline 的 `ttyWrite` 重写实现输入着色。

> **Node.js readline 的限制**：不像 JLine 有 `Highlighter` 接口，
> 需要用 `rlttyWrite` 或 `keypress` 事件手动实现。
> M7 先实现简化版：只在输入 `/` 开头时整体着色。

```typescript
// src/ui/input-highlighter.ts

/**
 * 简化版输入高亮
 * 对标 PaiCliHighlighter，但受限于 Node readline API
 *
 * 方案：在用户按 Enter 后、发送前，对输入做着色回显
 * （不实现实时着色——Node readline 不支持）
 */
export function highlightInput(input: string): string {
  if (input.startsWith('/')) {
    return chalk.cyan.bold(input)           // slash 命令
  }
  if (input.startsWith('!')) {
    return chalk.yellow(input.slice(1))     // shell 命令
  }
  return input
}
```

### 3.12 `history.ts` — 命令历史持久化

对标 `PaiCliHistory.java`（简化版）：

```typescript
// src/ui/history.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HISTORY_DIR = join(homedir(), '.spark', 'history')
const HISTORY_FILE = join(HISTORY_DIR, 'input.history')
const MAX_HISTORY = 2000

export function loadHistory(): string[] {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean).slice(-MAX_HISTORY)
  } catch { return [] }
}

export function appendHistory(line: string): void {
  // 过滤敏感信息（对标 PaiCliHistory）
  if (line.length > 8000) return
  if (/api[_-]?key|token|password|secret|bearer/i.test(line)) return
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, line + '\n', { flag: 'a' })
  } catch { /* ignore */ }
}
```

---

## 4. 事件驱动集成

### 4.1 事件 → TUI 映射

PaiCLI 的 `InlineRenderer` 通过 `Renderer` 接口接收事件。
SparkCode 通过 `EventBus` 订阅事件，映射关系：

| SparkCode 事件 | PaiCLI Renderer 方法 | TUI 动作 |
|---|---|---|
| `assistant/chunk` (content) | `stream().write(text)` | `inlineRenderer.write(text)` |
| `assistant/chunk` (reasoning) | `appendThinking(delta)` | `activityDisplay.appendThinking()` |
| `tool/call` | `appendToolCalls(list)` | `toolCallRenderer.render()` → `FoldableBlock` |
| `tool/result` | （内联打印） | 成功绿色 / 失败红色 |
| `turn/start` | `beginTurn()` | `inlineRenderer.beginTurn()` |
| `turn/end` | `endThinking()` | `activityDisplay.end()` |
| `compact/done` | (status update) | `statusBar.update()` |

### 4.2 重构 `index.ts` 的 `setupEventRendering`

```typescript
// src/index.ts — 重构后的事件渲染

function setupEventRendering(agent: SparkAgent, config: SparkConfig, ui: TuiState): void {
  const ctx = agent.ctx

  // assistant/chunk → 流式写入 InlineRenderer
  ctx.events.on('assistant/chunk', (data) => {
    if (data.chunk.kind === 'content' && data.chunk.text) {
      ui.renderer.write(data.chunk.text)
    }
    if (data.chunk.kind === 'reasoning' && data.chunk.text) {
      ui.activityDisplay.appendThinking(data.chunk.text)
    }
  })

  // tool/call → 折叠块
  ctx.events.on('tool/call', (data) => {
    ui.activityDisplay.end()  // 结束思考动画
    const grouped = groupToolCalls([{ id: data.callId, name: data.name, arguments: data.arguments }])
    const header = collapsedHeader(grouped)
    const expanded = expandedLines(grouped)
    const block = new FoldableBlock(header, expanded)
    block.renderCollapsed()
  })

  // tool/result → 结果状态
  ctx.events.on('tool/result', (data) => {
    const icon = data.message.isError ? '✗' : '✓'
    const color = data.message.isError ? style.error : style.success
    process.stdout.write(color(`${icon} ${truncate(data.message.content, 200)}\n`) + '\n')
  })

  // turn/start → 重置渲染器
  ctx.events.on('turn/start', () => {
    ui.renderer.beginTurn()
    ui.activityDisplay.begin('Thinking')
  })

  // turn/end → 结束动画 + 更新状态栏
  ctx.events.on('turn/end', () => {
    ui.activityDisplay.end()
    updateStatusBar(ui, agent)
  })

  // compact/done → 更新状态栏
  ctx.events.on('compact/done', () => {
    updateStatusBar(ui, agent)
  })
}
```

### 4.3 新的 REPL 主循环

```typescript
// src/index.ts — 重构后的 runRepl

async function runRepl(agent: SparkAgent, config: SparkConfig): Promise<void> {
  const registry = await createCommandSystem(agent, config)

  // 创建 TUI 组件
  const statusBar = new StatusBar()
  const activityDisplay = new ActivityDisplay()
  const renderer = new InlineRenderer(statusBar, activityDisplay)
  const completer = createCompleter(registry)

  // 加载历史
  const history = loadHistory()
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    completer,
    history,
    historySize: 2000,
  })

  // 打印欢迎横幅（对标 PaiCLI installStartupScreen）
  const banner = buildBannerLines({
    model: agent.currentModel,
    provider: 'mimo',
    skills: registry.getAllNames().filter(n => n.startsWith('/') && !['/help','/exit','/compact','/sessions','/new','/rename','/model','/effort','/skills','/plan','/auto','/normal'].includes(n)).length,
    mode: agent.mode,
    version: '0.1.0',
  })
  for (const line of banner) stdout.write(line + '\n')

  // 事件渲染
  setupEventRendering(agent, config, { renderer, activityDisplay, statusBar })

  // 初始状态栏
  updateStatusBar({ statusBar, activityDisplay, renderer }, agent)

  // REPL 循环
  const prompt = buildPrompt(agent)
  rl.setPrompt(prompt)

  while (true) {
    try {
      const input = await rl.question(prompt)
      const trimmed = input.trim()
      if (!trimmed) continue
      if (trimmed === '/exit' || trimmed === '/quit') break

      // 记录历史
      appendHistory(trimmed)

      // 命令系统
      const handled = await registry.execute(trimmed, commandCtx)
      if (handled) continue

      // Shell 命令
      if (trimmed.startsWith('!')) {
        await executeDirectCommand(agent.tools, trimmed.slice(1).trim(), config)
        continue
      }

      // 对话模式：打印用户消息块（对标 printSubmittedPrompt）
      renderer.printUserMessage(trimmed)
      agent.followup(trimmed)
      await agent.waitForTurnEnd()

      // 更新状态栏
      updateStatusBar({ statusBar, activityDisplay, renderer }, agent)

    } catch { break }
  }

  statusBar.hide()
  rl.close()
}
```

---

## 5. 快捷键

对标 PaiCLI 的 key bindings：

| 快捷键 | PaiCLI 行为 | SparkCode 实现 |
|---|---|---|
| **Ctrl+O** | 切换最后一个折叠块 | `rl.on('keypress')` → `renderer.toggleLastBlock()` |
| **Ctrl+C** | 取消 / 退出 | 已有，保持 |
| **Ctrl+D** | 退出 | 已有，保持 |
| **Esc** | 清空输入 | `rl.on('keypress')` → `rl.clearLine()` |
| **Tab** | 补全 | 已有，保持 |
| **Up/Down** | 历史导航 | readline 内置 |

**实现**（在 `runRepl` 中添加 keypress 监听）：

```typescript
// 监听 Ctrl+O
if (input === '\x0F') {  // Ctrl+O
  renderer.toggleLastBlock()
  continue
}
```

---

## 6. 实现阶段

### Phase 1：基础设施（day 1）✅
- [x] `ansi.ts` — ANSI 常量
- [x] `caps.ts` — 终端能力
- [x] `style.ts` — chalk 样式
- [x] 安装 `chalk` 依赖

### Phase 2：状态栏 + 横幅（day 1-2）✅
- [x] `status-bar.ts` — 底部 2 行 dock
- [x] `banner.ts` — SPARK ASCII art 欢迎屏
- [x] 集成到 `runRepl`

### Phase 3：活动动画（day 2）✅
- [x] `activity-display.ts` — Braille spinner + reasoning

### Phase 4：工具调用 + 折叠（day 2-3）
- [ ] `foldable-block.ts` — 可折叠块
- [ ] `block-registry.ts` — 注册表 + Ctrl+O
- [ ] `tool-call-renderer.ts` — 工具调用格式化

### Phase 5：流式渲染器（day 3）
- [ ] `inline-renderer.ts` — 代码块折叠状态机
- [ ] 重构 `setupEventRendering`

### Phase 6：Markdown + 高亮（day 3）
- [ ] `markdown.ts` — 终端 Markdown 渲染
- [ ] `input-highlighter.ts` — 输入着色
- [ ] `history.ts` — 历史持久化

### Phase 7：集成 + 测试（day 3-4）
- [ ] 重构 `index.ts` 主循环
- [ ] 快捷键绑定
- [ ] 整体测试

---

## 7. 与 PaiCLI 功能对照表

| 功能 | PaiCLI | SparkCode M7 | 状态 |
|------|--------|-------------|------|
| 欢迎屏幕（ASCII art） | ✅ Pi symbol | ✅ S symbol | 规划 |
| 底部状态栏（2 行 dock） | ✅ JLine Status | ✅ 顶部状态栏（原地覆写，不漂移） | 规划 |
| 思考 spinner（Braille） | ✅ InlineActivityDisplay | ✅ ActivityDisplay | 规划 |
| 推理预览（4 行） | ✅ │ prefix | ✅ │ prefix | 规划 |
| 进度条（活动模式） | ✅ ▰▱ bar | ✅ ▰▱ bar | 规划 |
| 代码块折叠 | ✅ FoldableBlock | ✅ FoldableBlock | 规划 |
| Ctrl+O 展开/折叠 | ✅ toggleLastBlock | ✅ toggleLastBlock | 规划 |
| 工具调用折叠块 | ✅ ToolCallRenderer | ✅ ToolCallRenderer | 规划 |
| 用户消息块（紫色背景） | ✅ userMessageBlock | ✅ userMessageBlock | 规划 |
| 上下文进度条（8 字符） | ✅ ctx ████████░░ | ✅ ctx ████████░░ | 规划 |
| Token 格式化 | ✅ X.Xk / X.XM | ✅ X.Xk / X.XM | 规划 |
| Markdown 渲染 | ✅ TerminalMarkdownRenderer | ✅ MarkdownRenderer | 规划 |
| 输入历史（持久化） | ✅ PaiCliHistory | ✅ ~/.spark/history | 规划 |
| Tab 补全 | ✅ PaiCliCompleter | ✅ completer.ts | 已有 |
| 输入高亮 | ✅ PaiCliHighlighter | ⚠️ 简化版 | 规划 |
| Esc 清空输入 | ✅ | ✅ | 规划 |
| Ctrl+V 粘贴图片 | ✅ | ❌ 不实现 | — |
| Lanterna 全屏模式 | ✅ | ❌ 不实现 | — |
| Slash Palette（↑↓选择） | ✅ SlashPalette | ❌ 不实现 | — |
| HITL 审批提示 | ✅ InlineApprovalPrompter | ❌ 不实现（M6 Auto 模式替代） | — |
| Diff 渲染 | ✅ InlineDiffRenderer | ❌ 不实现 | — |

---

## 8. 验收标准

1. `npm run spark` 启动后显示 SPARK ASCII art 欢迎屏
2. 底部固定 2 行状态栏显示 model、mode、effort、context bar、tokens、cwd
3. 模型思考时显示 Braille spinner + reasoning 预览（4 行）
4. 工具调用显示为可折叠块（`⏵` 折叠态）
5. 代码块自动折叠，Ctrl+O 展开/收起
6. 流式输出正常，不与状态栏冲突
7. `/model`、`/plan`、`/effort` 切换后状态栏实时更新
8. Tab 补全正常工作
9. 命令历史跨会话持久化
10. 终端窗口 resize 后状态栏自适应
