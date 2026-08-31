// persist/writer.ts — JSONL 流式写入器

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SessionEvent } from '../core/session.js'

export class JsonlWriter {
  private stream: fs.WriteStream
  private filePath: string

  constructor(dir: string, sessionId: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, `${sessionId}.jsonl`)
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
  }

  /** 追加一个事件 */
  write(event: SessionEvent): void {
    this.stream.write(JSON.stringify(event) + '\n')
  }

  /** 关闭流 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end(() => resolve())
      this.stream.once('error', reject)
    })
  }

  get path(): string {
    return this.filePath
  }
}
