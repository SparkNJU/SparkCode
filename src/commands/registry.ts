// commands/registry.ts — 命令注册表

import type { SparkAgent } from '../core/loop.js'
import type { SparkConfig } from '../config.js'

/** 命令定义 */
export interface CommandDefinition {
  name: string                    // 命令名（不含 /）
  aliases?: string[]              // 别名（如 /? -> /help）
  description: string             // 帮助描述
  args?: Array<{
    name: string
    required: boolean
    description: string
  }>
  handler: CommandHandler
}

/** 命令处理函数 */
export type CommandHandler = (
  args: string,
  ctx: CommandContext,
) => Promise<string | void> | string | void

/** 命令执行上下文 */
export interface CommandContext {
  agent: SparkAgent
  config: SparkConfig
  cwd: string
  print: (text: string) => void
}

/** 命令注册表 */
export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>()
  private aliases = new Map<string, string>()  // alias -> canonical name

  /** 注册命令 */
  register(def: CommandDefinition): () => void {
    this.commands.set(def.name, def)
    for (const alias of def.aliases ?? []) {
      this.aliases.set(alias, def.name)
    }
    return () => {
      this.commands.delete(def.name)
      for (const alias of def.aliases ?? []) {
        this.aliases.delete(alias)
      }
    }
  }

  /** 解析并执行命令，返回 true 表示已处理 */
  async execute(input: string, ctx: CommandContext): Promise<boolean> {
    if (!input.startsWith('/')) return false

    const spaceIndex = input.indexOf(' ')
    const namePart = spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex)
    const args = spaceIndex === -1 ? '' : input.slice(spaceIndex + 1).trim()

    const name = namePart.toLowerCase()
    const canonical = this.aliases.get(name) ?? name
    const cmd = this.commands.get(canonical)
    if (!cmd) return false

    const result = await cmd.handler(args, ctx)
    if (result) ctx.print(result)
    return true
  }

  /** 获取所有命令名（用于 Tab 补全） */
  getAllNames(): string[] {
    const names = new Set<string>()
    for (const name of this.commands.keys()) names.add(name)
    for (const alias of this.aliases.keys()) names.add(alias)
    return [...names]
  }

  /** 获取命令定义 */
  get(name: string): CommandDefinition | undefined {
    const canonical = this.aliases.get(name) ?? name
    return this.commands.get(canonical)
  }

  /** 格式化帮助文本 */
  formatHelp(): string {
    const lines = ['可用命令:']
    for (const [name, cmd] of this.commands) {
      const args = cmd.args?.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ') ?? ''
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map(a => `/${a}`).join(', ')})` : ''
      lines.push(`  /${name} ${args}  ${cmd.description}${aliases}`)
    }
    return lines.join('\n')
  }
}
