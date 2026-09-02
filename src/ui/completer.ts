// ui/completer.ts — Tab 补全

import type { CommandRegistry } from '../commands/registry.js'

/**
 * 创建 readline 补全函数
 * 输入 / 后按 Tab 循环补全匹配的命令
 */
export function createCompleter(registry: CommandRegistry) {
  return function completer(line: string): [string[], string] {
    // 只对 / 开头的输入补全
    if (!line.startsWith('/')) {
      return [[], line]
    }

    const partial = line.slice(1).toLowerCase()
    const allCommands = registry.getAllNames()

    // 前缀匹配
    const matches = allCommands
      .filter(name => name.startsWith(partial))
      .map(name => `/${name}`)

    return [matches, line]
  }
}
