/**
 * search.ts — 搜索工具集
 *
 * 提供 glob / grep 两个工具，纯 Node.js 实现（无外部依赖）。
 * - glob: 递归目录遍历，支持 ** 和 * 通配符
 * - grep: 正则搜索，输出 file:line:text 格式
 *
 * 跳过 node_modules / .git / dist 等目录。
 */

import fs from 'fs'
import path from 'path'
import type { ToolDefinition, ToolResult, ToolRunContext } from './types.js'
import { resolvePath, isWithinWorkspace } from './guard.js'

// 需要跳过的目录
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__'])

// ─────────────── 简易 glob 匹配（纯 Node.js 实现） ───────────────

/**
 * 将 glob 模式转为正则表达式
 * - ** 匹配任意深度路径
 * - *  匹配单层目录/文件名中的任意字符（不含路径分隔符）
 * - ?  匹配单个字符
 */
function globToRegex(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '.') {
      regex += '\\.'
      i++
    } else {
      regex += ch
      i++
    }
  }
  return new RegExp('^' + regex + '$')
}

/**
 * 递归遍历目录，返回所有文件的相对路径
 */
function walkDir(dir: string, base: string): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results // 无权限等
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(base, fullPath)

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base))
    } else if (entry.isFile()) {
      results.push(relPath)
    }
  }
  return results
}

// 结果截断限制
const GLOB_MAX_RESULTS = 1000
const GREP_MAX_RESULTS = 500
const GREP_MAX_FILE_SIZE = 1_000_000

// ───────────────────────── glob ─────────────────────────

export const globTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: '查找匹配模式的文件。支持 **（任意深度）和 *（单层）通配符。跳过 node_modules/.git/dist。返回最多 1000 条结果。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts" 或 "src/**/*.json"' },
          path:    { type: 'string', description: '搜索根目录（默认为工作目录）' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = args.pattern as string
    const searchPath = args.path as string | undefined

    const searchRoot = searchPath
      ? resolvePath(ctx.cwd, searchPath)
      : ctx.cwd

    if (!isWithinWorkspace(searchRoot, ctx.cwd)) {
      return { content: `搜索路径越界: "${searchPath}" 不在工作目录内`, isError: true }
    }

    if (!fs.existsSync(searchRoot)) {
      return { content: `搜索路径不存在: "${searchPath ?? '.'}"`, isError: true }
    }

    const allFiles = walkDir(searchRoot, searchRoot)
    const regex = globToRegex(pattern)
    const matched = allFiles.filter(f => regex.test(f))

    if (matched.length === 0) {
      return { content: `未找到匹配 "${pattern}" 的文件。`, isError: false }
    }

    const truncated = matched.length > GLOB_MAX_RESULTS
    const display = truncated ? matched.slice(0, GLOB_MAX_RESULTS) : matched

    let result = display.join('\n')
    if (truncated) {
      result += `\n... [结果已截断，显示前 ${GLOB_MAX_RESULTS} 条，共 ${matched.length} 条匹配]`
    }

    return { content: result, isError: false }
  },
}

// ───────────────────────── grep ─────────────────────────

/**
 * 在单个文件中搜索正则匹配，返回匹配行
 */
function grepFile(filePath: string, regex: RegExp, relPath: string): string[] {
  const results: string[] = []
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > GREP_MAX_FILE_SIZE) return results

    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    // 每次搜索前重置 lastIndex（因为 regex 带 g 标志）
    regex.lastIndex = 0

    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        let line = lines[i]
        if (line.length > 300) {
          line = line.slice(0, 300) + '...'
        }
        results.push(`${relPath}:${i + 1}:${line}`)
      }
      if (results.length >= GREP_MAX_RESULTS) break
    }
  } catch {
    // 跳过无法读取的文件
  }
  return results
}

/**
 * 递归搜索目录中的所有文件
 */
function grepDir(dir: string, base: string, regex: RegExp, fileGlob: RegExp | null): string[] {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(base, fullPath)

    if (entry.isDirectory()) {
      results.push(...grepDir(fullPath, base, regex, fileGlob))
    } else if (entry.isFile()) {
      if (fileGlob && !fileGlob.test(entry.name)) continue
      results.push(...grepFile(fullPath, regex, relPath))
    }

    if (results.length >= GREP_MAX_RESULTS) break
  }
  return results
}

export const grepTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'grep',
      description: '搜索文件内容（正则匹配）。输出格式: file:line:text。跳过 node_modules/.git/dist 和大文件（>1MB）。返回最多 500 条结果。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式，如 "useState" 或 "function\\s+\\w+"' },
          path:    { type: 'string', description: '搜索根目录（默认为工作目录）' },
          glob:    { type: 'string', description: '文件名过滤，如 "*.ts" 或 "*.{ts,tsx}"' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = args.pattern as string
    const searchPath = args.path as string | undefined
    const fileGlobStr = args.glob as string | undefined

    const searchRoot = searchPath
      ? resolvePath(ctx.cwd, searchPath)
      : ctx.cwd

    if (!isWithinWorkspace(searchRoot, ctx.cwd)) {
      return { content: `搜索路径越界: "${searchPath}" 不在工作目录内`, isError: true }
    }

    if (!fs.existsSync(searchRoot)) {
      return { content: `搜索路径不存在: "${searchPath ?? '.'}"`, isError: true }
    }

    // 编译正则
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'g')
    } catch (e: any) {
      return { content: `无效的正则表达式: "${pattern}" — ${e.message}`, isError: true }
    }

    // 文件名过滤
    let fileGlob: RegExp | null = null
    if (fileGlobStr) {
      let globRegex = fileGlobStr
        .replace(/\./g, '\\.')
        .replace(/\{([^}]+)\}/g, (_: string, group: string) => `(${group.split(',').join('|')})`)
        .replace(/\*/g, '.*')
      fileGlob = new RegExp(`^${globRegex}$`)
    }

    const matches = grepDir(searchRoot, searchRoot, regex, fileGlob)

    if (matches.length === 0) {
      return { content: `未找到匹配 "${pattern}" 的内容。`, isError: false }
    }

    const truncated = matches.length > GREP_MAX_RESULTS
    const display = truncated ? matches.slice(0, GREP_MAX_RESULTS) : matches

    let result = display.join('\n')
    if (truncated) {
      result += `\n... [结果已截断，显示前 ${GREP_MAX_RESULTS} 条，共 ${matches.length} 条匹配]`
    }

    return { content: result, isError: false }
  },
}
