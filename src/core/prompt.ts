// core/prompt.ts — Prompt 组装器

import type { Session, UserMessage } from './session.js'
import type { SparkConfig } from '../config.js'
import type { ToolSchema } from '../tools/types.js'
import type { AgentMode } from './modes.js'
import { MODE_CONFIGS } from './modes.js'
import type { EffortLevel } from './effort.js'
import { EFFORT_PROMPTS } from './effort.js'

export interface PromptAssembly {
  header: {
    model: string
    systemPrompt: string
    tools?: ToolSchema[]
  }
  messages: UserMessage[]
}

/** 组装发送给 LLM 的 prompt */
export function assemblePrompt(
  session: Session,
  config: SparkConfig,
  tools?: ToolSchema[],
  options?: {
    mode?: AgentMode
    effort?: EffortLevel
    currentModel?: string
  }
): PromptAssembly {
  const systemPrompt = buildSystemPrompt(config, tools, options)

  return {
    header: {
      model: options?.currentModel ?? config.model,
      systemPrompt,
      tools,
    },
    messages: [], // 具体消息由 loop 从 inbox 注入
  }
}

/** 构建系统提示词 */
function buildSystemPrompt(
  config: SparkConfig,
  tools?: ToolSchema[],
  options?: {
    mode?: AgentMode
    effort?: EffortLevel
  }
): string {
  const sections: string[] = []

  sections.push(
    `你是 Spark Code，一个编程智能体。你可以帮助用户完成编程任务。`,
  )

  // M6: 注入模式提示词
  if (options?.mode && options.mode !== 'normal') {
    const modeConfig = MODE_CONFIGS[options.mode]
    if (modeConfig.promptInjection) {
      sections.push(modeConfig.promptInjection)
    }
  }

  // M6: 注入 effort 提示词
  if (options?.effort && options.effort !== 'medium') {
    const effortPrompt = EFFORT_PROMPTS[options.effort]
    if (effortPrompt) {
      sections.push(effortPrompt)
    }
  }

  if (tools && tools.length > 0) {
    // 有工具时：描述可用工具，指导模型使用 function calling
    const toolNames = tools.map(t => t.function.name).join('、')
    sections.push(
      `你当前可用的工具：${toolNames}。

使用工具时，请直接输出工具调用（function calling），系统会自动执行并返回结果。
不要在回复中描述你要执行什么操作——直接调用工具即可。`,
    )
  } else {
    // 无工具时：描述性提示（M1 兼容）
    sections.push(
      `请用中文回复。当需要执行操作时，直接说明你的计划并执行。`,
    )
  }

  sections.push(`当前工作目录：${config.workspace}`)

  return sections.join('\n\n')
}
