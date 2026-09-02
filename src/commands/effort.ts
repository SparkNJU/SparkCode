// commands/effort.ts — 推理深度命令

import type { CommandRegistry } from './registry.js'
import type { EffortLevel } from '../core/effort.js'

/** 注册 Effort 命令 */
export function registerEffortCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'effort',
    aliases: ['e'],
    description: '设置推理深度',
    args: [{ name: 'level', required: false, description: 'low/medium/high' }],
    handler: async (args, ctx) => {
      const validLevels: EffortLevel[] = ['low', 'medium', 'high']

      if (!args) {
        const lines = [
          `当前推理深度: ${ctx.agent.effort}`,
          '',
          '可用级别:',
          '  low    - 快速简短回答',
          '  medium - 平衡速度与质量（默认）',
          '  high   - 深度分析，详细推理',
          '',
          '用法: /effort <级别>',
        ]
        return lines.join('\n')
      }

      const level = args.toLowerCase() as EffortLevel
      if (!validLevels.includes(level)) {
        return `无效的推理深度: ${args}。可用: ${validLevels.join(', ')}`
      }

      ctx.agent.setEffort(level)
      return `\n✅ 推理深度已设置为: ${level}\n`
    },
  })
}
