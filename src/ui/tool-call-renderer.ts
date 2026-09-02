// ui/tool-call-renderer.ts — 工具调用格式化
// 对标 PaiCLI ToolCallRenderer.java
// 将工具调用列表分组，生成折叠头和展开行

import { subtle } from './style.js'

export interface ToolCallInput {
  name: string
  arguments: string   // 原始 JSON 字符串
}

/** 按工具名分组，保持插入顺序 */
export function groupToolCalls(calls: ToolCallInput[]): Map<string, ToolCallInput[]> {
  const grouped = new Map<string, ToolCallInput[]>()
  for (const tc of calls) {
    const list = grouped.get(tc.name) || []
    list.push(tc)
    grouped.set(tc.name, list)
  }
  return grouped
}

/** 生成折叠头。单组：`⏵ toolLabel (ctrl+o to expand)`；多组：`⏵ N groups / M calls` */
export function collapsedHeader(grouped: Map<string, ToolCallInput[]>): string {
  if (grouped.size === 1) {
    const [name, calls] = [...grouped.entries()][0]!
    if (calls.length === 1) {
      // 单个调用：显示 key param
      return subtle(`⏵ ${toolCollapsedLabel(name, calls[0]!)} (ctrl+o to expand)`)
    }
    return subtle(`⏵ ${toolLabel(name, calls.length)} (ctrl+o to expand)`)
  }
  const total = [...grouped.values()].reduce((s, c) => s + c.length, 0)
  return subtle(`⏵ ${grouped.size} groups / ${total} calls (ctrl+o to expand)`)
}

/** 生成展开行：缩进的组标签 + └ 细节行 */
export function expandedLines(grouped: Map<string, ToolCallInput[]>): string[] {
  const lines: string[] = []
  for (const [name, calls] of grouped) {
    lines.push(subtle(`  ${toolLabel(name, calls.length)}`))
    for (const tc of calls) {
      const detail = extractKeyParam(name, tc.arguments)
      if (detail) lines.push(subtle(`    └ ${detail}`))
    }
  }
  return lines
}

/** 工具名 → emoji + 标签 */
export function toolLabel(name: string, count: number): string {
  const icons: Record<string, string> = {
    bash: '⚡', read: '📖', write: '✏️', edit: '✏️',
    glob: '📂', grep: '🔍', web_fetch: '📰', web_search: '🌐',
  }
  const icon = icons[name] || '🔧'
  return `${icon} ${name}` + (count > 1 ? ` × ${count}` : '')
}

/** 单个调用的折叠标签（含 key param） */
export function toolCollapsedLabel(name: string, call: ToolCallInput): string {
  const param = extractKeyParam(name, call.arguments)
  const icons: Record<string, string> = {
    bash: '⚡', read: '📖', write: '✏️', edit: '✏️',
    glob: '📂', grep: '🔍', web_fetch: '📰', web_search: '🌐',
  }
  const icon = icons[name] || '🔧'
  if (param) {
    const short = param.length > 60 ? param.slice(0, 57) + '...' : param
    return `${icon} ${name}(${short})`
  }
  return `${icon} ${name}`
}

/** 提取关键参数（bash→command, read→path, grep→pattern 等），截断 80 字符 */
export function extractKeyParam(name: string, argsJson: string): string {
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
  } catch {
    return argsJson.length > 80 ? argsJson.slice(0, 77) + '...' : argsJson
  }
}
