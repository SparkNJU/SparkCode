// core/effort.ts — 推理深度定义

/** 推理深度级别 */
export type EffortLevel = 'low' | 'medium' | 'high'

/** 推理深度提示词 */
export const EFFORT_PROMPTS: Record<EffortLevel, string> = {
  low: '给出简洁直接的回答，尽量减少解释。',
  medium: '',
  high: '逐步思考，详细分析，考虑边界情况和潜在问题。',
}

/** 获取 API 参数（用于支持 reasoning_effort 的模型） */
export function getEffortApiParams(level: EffortLevel): Record<string, unknown> {
  if (level === 'low') return { reasoning_effort: 'low' }
  if (level === 'high') return { reasoning_effort: 'high' }
  return {}
}
