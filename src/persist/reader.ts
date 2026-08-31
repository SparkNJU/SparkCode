// persist/reader.ts — JSONL 读取器

import * as fs from 'node:fs'
import type { SessionEvent } from '../core/session.js'

export function readJsonl(filePath: string): SessionEvent[] {
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(line => line.trim())
  const events: SessionEvent[] = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as SessionEvent
      if (event.seq !== undefined && event.type) {
        events.push(event)
      }
    } catch {
      // 跳过损坏的行
    }
  }

  return events
}
