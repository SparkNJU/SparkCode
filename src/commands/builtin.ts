// commands/builtin.ts — 内置命令注册

import { CommandRegistry, type CommandContext } from './registry.js'
import { showSessionPicker } from '../persist/picker.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/** 注册所有内置命令 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  // /help
  registry.register({
    name: 'help',
    aliases: ['?', 'h'],
    description: '显示可用命令',
    handler: (_args, ctx) => {
      return `\n${registry.formatHelp()}\n`
    },
  })

  // /exit, /quit
  registry.register({
    name: 'exit',
    aliases: ['quit', 'q'],
    description: '退出 REPL',
    handler: () => process.exit(0),
  })

  // /compact
  registry.register({
    name: 'compact',
    aliases: ['c'],
    description: '手动触发上下文压缩',
    handler: async (_args, ctx) => {
      const messages = ctx.agent.session.deriveMessages()
      const log = ctx.agent.session.getLog()
      const lines = [
        '',
        '📊 上下文状态：',
        `  消息数：${messages.length}`,
        `  事件数：${log.length}`,
        `  触发自动压缩阈值：${ctx.config.compaction.threshold} token`,
        '',
        '🔄 手动触发压缩...',
      ]
      ctx.print(lines.join('\n'))

      await (ctx.agent as any).maybeCompactContext()

      const afterMessages = ctx.agent.session.deriveMessages()
      ctx.print(`  压缩后消息数：${afterMessages.length}\n`)
    },
  })

  // /resume
  registry.register({
    name: 'resume',
    description: '从磁盘重新加载当前会话',
    handler: async (_args, ctx) => {
      const sessionId = ctx.agent.session.id
      try {
        await ctx.agent.resume(sessionId)
        const messages = ctx.agent.session.deriveMessages()
        return `\n📂 已从磁盘重新加载会话: ${sessionId}\n  消息数: ${messages.length}\n`
      } catch {
        return `\n⚠️  无法加载会话 ${sessionId}\n`
      }
    },
  })

  // /sessions
  registry.register({
    name: 'sessions',
    aliases: ['ls'],
    description: '切换会话（输入序号选择）',
    handler: async (_args, ctx) => {
      const store = ctx.agent.getStore()
      const sessions = store.list()

      const rl = createInterface({ input: stdin, output: stdout, terminal: true })
      const result = await showSessionPicker(sessions, rl, stdout)
      rl.close()

      // 处理删除的会话
      for (const deletedId of result.deletedIds) {
        ctx.agent.deleteSession(deletedId)
      }
      if (result.deletedIds.length > 0) {
        ctx.print(`\n🗑️  已删除 ${result.deletedIds.length} 个会话`)
      }

      if (result.action === 'select' && result.sessionId) {
        await ctx.agent.resume(result.sessionId)
        return `\n📂 已恢复会话: ${result.sessionId}\n`
      }
      return '\n已取消\n'
    },
  })

  // /new
  registry.register({
    name: 'new',
    description: '创建新会话',
    handler: async (_args, ctx) => {
      ctx.agent.newSession()
      return `\n✨ 已创建新会话: ${ctx.agent.session.id}\n`
    },
  })

  // /rename
  registry.register({
    name: 'rename',
    description: '重命名当前会话',
    args: [{ name: '标题', required: true, description: '新的会话标题' }],
    handler: async (args, ctx) => {
      if (!args) return '\n用法: /rename <会话标题>\n'
      ctx.agent.renameSession(args)
      return `\n✏️  会话已重命名为: "${args}"\n`
    },
  })
}
