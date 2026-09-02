// commands/skills.ts — Skill 命令

import type { CommandRegistry, CommandContext } from './registry.js'
import { loadAllSkills, type SkillDefinition } from '../skills/loader.js'

/** 注册 Skill 相关命令 */
export async function registerSkillCommands(
  registry: CommandRegistry,
  cwd: string,
): Promise<SkillDefinition[]> {
  const skills = await loadAllSkills(cwd)

  // /skills — 列出所有 Skill
  registry.register({
    name: 'skills',
    description: '列出可用的自定义 Skill',
    handler: () => {
      if (skills.length === 0) {
        return '未找到自定义 Skill。创建 .spark/commands/*.md 文件来添加 Skill。'
      }

      const lines = ['可用 Skill:']
      for (const skill of skills) {
        lines.push(`  /${skill.name}  ${skill.description} (${skill.source})`)
      }
      lines.push('')
      lines.push('用法: /skill-name [参数]')
      return lines.join('\n')
    },
  })

  // /refresh — 重新加载 Skill
  registry.register({
    name: 'refresh',
    description: '重新加载 Skill 文件',
    handler: async (_args, ctx) => {
      const newSkills = await loadAllSkills(cwd)
      // 重新注册 Skill 命令
      registerSkillEntries(registry, newSkills, ctx)
      return `\n🔄 已重新加载 ${newSkills.length} 个 Skill\n`
    },
  })

  // 注册每个 Skill 为独立命令
  registerSkillEntries(registry, skills, { agent: null as any, config: null as any, cwd, print: () => {} })

  return skills
}

/** 注册 Skill 条目为命令 */
function registerSkillEntries(
  registry: CommandRegistry,
  skills: SkillDefinition[],
  _ctx: CommandContext,
): void {
  for (const skill of skills) {
    registry.register({
      name: skill.name,
      description: skill.description,
      args: [{ name: 'args', required: false, description: '传递给 Skill 的参数' }],
      handler: async (args, ctx) => {
        // 替换 $ARGUMENTS 占位符
        const processed = skill.body.replace(/\$ARGUMENTS/g, args ?? '')

        // 作为用户消息发送给 Agent
        ctx.agent.followup(processed)
        return `\n🎯 执行 Skill: ${skill.name}\n`
      },
    })
  }
}
