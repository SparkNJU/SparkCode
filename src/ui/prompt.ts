// ui/prompt.ts — 动态提示符

import type { SparkAgent } from '../core/loop.js'

/**
 * 构建动态提示符
 * 格式: ⚡ spark [模型] [模式] [effort] >
 */
export function buildPrompt(agent: SparkAgent): string {
  const parts = ['⚡ spark']

  // 模型名
  parts.push(`[${agent.currentModel}]`)

  // 模式（非 normal 时显示）
  if (agent.mode !== 'normal') {
    parts.push(`[${agent.mode}]`)
  }

  // effort（非 medium 时显示）
  if (agent.effort !== 'medium') {
    parts.push(`[${agent.effort}]`)
  }

  return parts.join(' ') + ' > '
}
