// persist/picker.ts — 会话选择器（基于 readline 文本输入）

import type * as readline from 'node:readline/promises'
import type { SessionMeta } from './store.js'

export interface PickerResult {
  action: 'select' | 'cancel'
  sessionId?: string
  deletedIds: string[]
}

/**
 * 会话选择器（文本输入模式，不依赖 raw stdin）
 *
 * 用户输入序号选择会话，输入 d <序号> 删除，输入 q 取消。
 */
export async function showSessionPicker(
  sessions: SessionMeta[],
  rl: readline.Interface,
  stdout: NodeJS.WriteStream,
): Promise<PickerResult> {
  const deletedIds: string[] = []

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
  }

  const render = () => {
    stdout.write('\n📂 选择会话:\n\n')

    if (sessions.length === 0) {
      stdout.write('  (无会话)\n')
    } else {
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i]!
        const idx = String(i + 1).padStart(3, '0')
        const time = formatTime(s.lastActiveAt)
        const msgCount = `${s.messageCount} 条消息`
        const title = s.title ? ` | "${s.title}"` : ''
        stdout.write(`  [${idx}] ${time} | ${msgCount}${title}\n`)
      }
    }

    stdout.write('\n')
    stdout.write('  输入序号加载会话 | d <序号> 删除 | q 取消\n')
  }

  // 循环直到用户做出有效选择
  while (true) {
    render()

    if (sessions.length === 0) {
      return { action: 'cancel', deletedIds }
    }

    const input = await rl.question('\n选择> ')
    const trimmed = input.trim().toLowerCase()

    // 取消
    if (trimmed === 'q' || trimmed === '') {
      return { action: 'cancel', deletedIds }
    }

    // 删除: d <序号>
    if (trimmed.startsWith('d ')) {
      const numStr = trimmed.slice(2).trim()
      const idx = parseInt(numStr, 10) - 1
      if (idx >= 0 && idx < sessions.length) {
        const confirm = await rl.question(`确定删除会话 "${sessions[idx]!.title ?? sessions[idx]!.id}"? [y/N] `)
        if (confirm.trim().toLowerCase() === 'y') {
          deletedIds.push(sessions[idx]!.id)
          sessions.splice(idx, 1)
          stdout.write(`\n🗑️  已删除\n`)
        }
      } else {
        stdout.write('\n⚠️  无效序号\n')
      }
      continue
    }

    // 选择: 序号
    const idx = parseInt(trimmed, 10) - 1
    if (idx >= 0 && idx < sessions.length) {
      return { action: 'select', sessionId: sessions[idx]!.id, deletedIds }
    }

    stdout.write('\n⚠️  无效输入，请输入序号、d <序号> 或 q\n')
  }
}
