// core/prompt.ts — Prompt 组装器

import type { Session, UserMessage } from './session.js'
import type { SparkConfig } from '../config.js'

export interface PromptAssembly {
  header: {
    model: string
    systemPrompt: string
  }
  messages: UserMessage[]
}

/** 组装发送给 LLM 的 prompt */
export function assemblePrompt(session: Session, config: SparkConfig): PromptAssembly {
  const systemPrompt = buildSystemPrompt(config)

  return {
    header: {
      model: config.model,
      systemPrompt,
    },
    messages: [], // 具体消息由 loop 从 inbox 注入
  }
}

/** 构建系统提示词（M1 简化版） */
function buildSystemPrompt(config: SparkConfig): string {
  const sections: string[] = []

  sections.push(
    `你是 Spark Code，一个编程智能体。你可以帮助用户完成编程任务。`,
  )

  sections.push(
    `你的能力包括：
- 读写文件
- 执行 Shell 命令
- 搜索代码（按文件名模式和内容正则）
- 抓取网页内容

请用中文回复。当需要执行操作时，直接说明你的计划并执行。`,
  )

  sections.push(`当前工作目录：${config.workspace}`)

  return sections.join('\n\n')
}
