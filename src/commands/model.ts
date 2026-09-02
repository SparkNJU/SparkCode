// commands/model.ts — 模型切换命令

import type { CommandRegistry } from './registry.js'

/** 模型预设 */
export interface ModelPreset {
  name: string
  model: string
  baseURL?: string
}

/** 默认模型预设 */
export const DEFAULT_MODEL_PRESETS: ModelPreset[] = [
  { name: 'mimo-v2.5', model: 'mimo-v2.5', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
  { name: 'mimo-v2.5-pro', model: 'mimo-v2.5-pro', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
]

/** 从环境变量加载模型预设 */
export function loadModelPresets(): ModelPreset[] {
  const presets = [...DEFAULT_MODEL_PRESETS]
  const envModels = process.env.SPARK_MODELS
  if (envModels) {
    for (const entry of envModels.split(',')) {
      const [name, model] = entry.split(':')
      if (name && model) {
        presets.push({ name: name.trim(), model: model.trim() })
      }
    }
  }
  return presets
}

/** 注册模型切换命令 */
export function registerModelCommand(registry: CommandRegistry, presets: ModelPreset[]): void {
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: '切换 LLM 模型',
    args: [{ name: 'name', required: false, description: '模型名称或序号' }],
    handler: async (args, ctx) => {
      // 无参数：显示模型列表
      if (!args) {
        const lines = ['可用模型:']
        presets.forEach((p, i) => {
          const current = p.model === ctx.agent.currentModel ? ' (当前)' : ''
          lines.push(`  ${i + 1}. ${p.name}${current}`)
        })
        lines.push('')
        lines.push('用法: /model <名称> 或 /model <序号>')
        return lines.join('\n')
      }

      // 按名称查找
      let preset = presets.find(p => p.name === args || p.model === args)

      // 按序号查找
      if (!preset) {
        const index = parseInt(args) - 1
        if (index >= 0 && index < presets.length) {
          preset = presets[index]
        }
      }

      if (!preset) {
        return `未知模型: ${args}。使用 /model 查看可用模型。`
      }

      // 执行切换
      ctx.agent.setModel(preset.model, preset.baseURL)
      return `\n✅ 已切换到模型: ${preset.name}\n`
    },
  })
}
