/**
 * fs.ts — 文件操作工具集
 *
 * 提供 read / write / edit 三个工具，均经过路径安全守卫校验。
 * - read:  读取文件内容，带行号显示，支持 offset/limit 分页
 * - write: 创建或覆盖文件，自动创建父目录
 * - edit:  精确字符串替换（Claude Code 风格），唯一性校验 + diff 预览
 */

import fs from 'fs'
import path from 'path'
import type { ToolDefinition, ToolResult, ToolRunContext } from './types.js'
import { assertReadable, assertWritable, resolvePath } from './guard.js'

// ───────────────────────── read ─────────────────────────

const READ_MAX_CHARS = 50_000

export const readTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文件内容（带行号）。支持 offset/limit 分页读取大文件。默认最多读 2000 行。',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string', description: '要读取的文件路径' },
          offset: { type: 'number', description: '起始行号（从 1 开始，默认 1）' },
          limit:  { type: 'number', description: '读取行数（默认 2000）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = args.path as string
    const offset = Math.max(1, (args.offset as number) ?? 1)
    const limit = (args.limit as number) ?? 2000

    try {
      assertReadable(filePath, ctx.cwd)
    } catch (e: any) {
      return { content: e.message, isError: true }
    }

    const resolved = resolvePath(ctx.cwd, filePath)
    const content = fs.readFileSync(resolved, 'utf-8')
    const allLines = content.split('\n')

    const start = offset - 1
    const end = Math.min(start + limit, allLines.length)

    if (start >= allLines.length) {
      return { content: `文件共 ${allLines.length} 行，offset=${offset} 超出范围。`, isError: false }
    }

    // 带行号输出
    const numbered: string[] = []
    for (let i = start; i < end; i++) {
      const lineNum = String(i + 1).padStart(5, ' ')
      numbered.push(`${lineNum}\t${allLines[i]}`)
    }

    let result = numbered.join('\n')

    // 截断保护
    if (result.length > READ_MAX_CHARS) {
      result = result.slice(0, READ_MAX_CHARS) + '\n... [输出已截断，超过 50K 字符]'
    }

    // 提示更多内容
    if (end < allLines.length) {
      result += `\n... [显示第 ${offset}-${end} 行，共 ${allLines.length} 行，可用 offset=${end + 1} 继续读取]`
    }

    return { content: result, isError: false }
  },
}

// ───────────────────────── write ─────────────────────────

export const writeTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'write',
      description: '创建或覆盖写入文件。自动创建父目录。',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: '要写入的文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = args.path as string
    const content = args.content as string

    try {
      assertWritable(filePath, ctx.cwd)
    } catch (e: any) {
      return { content: e.message, isError: true }
    }

    const resolved = resolvePath(ctx.cwd, filePath)
    const dir = path.dirname(resolved)

    // 自动创建父目录
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(resolved, content, 'utf-8')

    const lines = content.split('\n').length
    return { content: `文件已写入: ${filePath} (${lines} 行)`, isError: false }
  },
}

// ───────────────────────── edit ─────────────────────────

const EDIT_CONTEXT_LINES = 3

export const editTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'edit',
      description: '精确字符串替换（类似 Claude Code 的 str_replace_editor）。old_string 必须在文件中唯一存在。替换前展示 diff 预览。',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: '要编辑的文件路径' },
          old_string: { type: 'string', description: '要替换的原始字符串（必须在文件中唯一存在）' },
          new_string: { type: 'string', description: '替换后的新字符串' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = args.path as string
    const oldStr = args.old_string as string
    const newStr = args.new_string as string

    try {
      assertWritable(filePath, ctx.cwd)
    } catch (e: any) {
      return { content: e.message, isError: true }
    }

    const resolved = resolvePath(ctx.cwd, filePath)

    // 文件必须已存在
    if (!fs.existsSync(resolved)) {
      return { content: `文件不存在: "${filePath}"，请使用 write 工具创建`, isError: true }
    }

    const content = fs.readFileSync(resolved, 'utf-8')

    // 唯一性校验
    const count = content.split(oldStr).length - 1
    if (count === 0) {
      return {
        content: `old_string 在文件中未找到。请检查要替换的文本是否完全匹配（包括空格和缩进）。`,
        isError: true,
      }
    }
    if (count > 1) {
      return {
        content: `old_string 在文件中出现 ${count} 次，不唯一。请提供更多上下文使其唯一匹配（例如包含前后几行）。`,
        isError: true,
      }
    }

    // 执行替换
    const newContent = content.replace(oldStr, newStr)

    // diff 预览
    const beforeLines = content.split('\n')
    const afterLines = newContent.split('\n')
    const replaceStart = content.indexOf(oldStr)
    const beforeLineIdx = content.slice(0, replaceStart).split('\n').length - 1

    const preview: string[] = []
    const ctxStart = Math.max(0, beforeLineIdx - EDIT_CONTEXT_LINES)
    const oldLineCount = oldStr.split('\n').length
    const newLineCount = newStr.split('\n').length

    // 上文
    for (let i = ctxStart; i < beforeLineIdx; i++) {
      preview.push(`  ${beforeLines[i]}`)
    }
    // 旧行
    for (let i = beforeLineIdx; i < beforeLineIdx + oldLineCount; i++) {
      preview.push(`- ${beforeLines[i]}`)
    }
    // 新行
    for (let i = beforeLineIdx; i < beforeLineIdx + newLineCount; i++) {
      preview.push(`+ ${afterLines[i]}`)
    }
    // 下文
    const afterOldEnd = beforeLineIdx + oldLineCount
    for (let i = afterOldEnd; i < Math.min(beforeLines.length, afterOldEnd + EDIT_CONTEXT_LINES); i++) {
      preview.push(`  ${beforeLines[i]}`)
    }

    // 写入
    fs.writeFileSync(resolved, newContent, 'utf-8')

    return {
      content: `编辑完成: ${filePath}\n\nDiff 预览:\n${preview.join('\n')}`,
      isError: false,
    }
  },
}
