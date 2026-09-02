// core/modes.ts — 模式定义

/** Agent 模式 */
export type AgentMode = 'normal' | 'plan' | 'auto'

/** 模式配置 */
export interface ModeConfig {
  name: AgentMode
  description: string
  promptInjection: string
  toolFilter: (toolName: string) => boolean
}

/** 模式配置表 */
export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  normal: {
    name: 'normal',
    description: '默认模式：读工具自动批准，写/bash 需确认',
    promptInjection: '',
    toolFilter: () => true,
  },
  plan: {
    name: 'plan',
    description: '规划模式：只允许 read/search，禁止修改',
    promptInjection: `你处于规划模式（PLAN mode）。只分析和规划，不要执行任何修改操作。
使用 read/glob/grep 工具理解代码库，然后提供详细的计划。
不要使用 bash、write 或 edit 工具。`,
    toolFilter: (name) => ['read', 'glob', 'grep'].includes(name),
  },
  auto: {
    name: 'auto',
    description: '自动模式：所有工具自动批准',
    promptInjection: '你处于自动模式（AUTO mode）。所有工具自动批准，请高效执行任务。',
    toolFilter: () => true,
  },
}
