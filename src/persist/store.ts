// persist/store.ts — 会话存储管理

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { readJsonl } from './reader.js'

export interface SessionMeta {
  id: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
  title?: string
}

export class SessionStore {
  readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.spark-code', 'sessions')
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  /** 列出所有会话（按 lastActiveAt 倒序） */
  list(): SessionMeta[] {
    const metaFiles = fs.readdirSync(this.baseDir)
      .filter(f => f.endsWith('.meta.json'))

    return metaFiles
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.baseDir, f), 'utf-8')) as SessionMeta
        } catch {
          return null
        }
      })
      .filter((m): m is SessionMeta => m !== null)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** 保存会话元数据 */
  saveMeta(meta: SessionMeta): void {
    const filePath = path.join(this.baseDir, `${meta.id}.meta.json`)
    fs.writeFileSync(filePath, JSON.stringify(meta, null, 2))
  }

  /** 删除会话（磁盘文件） */
  delete(sessionId: string): void {
    const jsonlPath = path.join(this.baseDir, `${sessionId}.jsonl`)
    const metaPath = path.join(this.baseDir, `${sessionId}.meta.json`)
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath)
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)
  }

  /** 获取最近的会话 ID */
  getLatestId(): string | null {
    const sessions = this.list()
    return sessions.length > 0 ? sessions[0]!.id : null
  }

  /** JSONL 文件路径 */
  jsonlPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`)
  }

  /** 从 JSONL 提取标题（第一条用户消息，截断 40 字符） */
  extractTitle(sessionId: string): string {
    const filePath = this.jsonlPath(sessionId)
    if (!fs.existsSync(filePath)) return ''

    const events = readJsonl(filePath)
    for (const event of events) {
      if (event.type === 'user/message' && event.data?.content) {
        const text = event.data.content as string
        return text.length > 40 ? text.slice(0, 40) + '...' : text
      }
    }
    return ''
  }
}
