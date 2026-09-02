// commands/mode.ts — 模式切换命令

import type { CommandRegistry } from './registry.js'
import type { AgentMode } from '../core/modes.js'

/** 注册模式切换命令 */
export function registerModeCommands(registry: CommandRegistry): void {
  // /plan
  registry.register({
    name: 'plan',
    description: '切换到规划模式（只读分析）',
    args: [{ name: 'task', required: false, description: '要分析的任务' }],
    handler: async (args, ctx) => {
      ctx.agent.setMode('plan')
      if (args) {
        ctx.agent.followup(args)
        return '\n📋 已切换到规划模式，开始分析任务...\n'
      }
      return '\n📋 已切换到规划模式。只能使用 read/glob/grep 工具。\n'
    },
  })

  // /auto
  registry.register({
    name: 'auto',
    description: '切换到自动模式（所有工具自动批准）',
    args: [{ name: 'task', required: false, description: '要执行的任务' }],
    handler: async (args, ctx) => {
      ctx.agent.setMode('auto')
      if (args) {
        ctx.agent.followup(args)
        return '\n⚡ 已切换到自动模式，开始执行任务...\n'
      }
      return '\n⚡ 已切换到自动模式。所有工具自动批准。\n'
    },
  })

  // /normal
  registry.register({
    name: 'normal',
    aliases: ['n'],
    description: '切换到普通模式（默认）',
    handler: async (_args, ctx) => {
      ctx.agent.setMode('normal')
      return '\n💬 已切换到普通模式。\n'
    },
  })
}
