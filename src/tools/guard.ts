/**
 * guard.ts — 路径安全守卫
 *
 * 防止 LLM 通过路径穿越读写工作目录之外的文件。
 * 所有文件操作工具必须先调用 assertReadable/assertWritable 校验路径。
 */

import path from 'path'
import fs from 'fs'

/**
 * 将用户传入的路径解析为绝对路径，并规范化（去除 ..、多余斜杠等）
 */
export function resolvePath(workspace: string, filePath: string): string {
  // 如果 filePath 已经是绝对路径，直接规范化
  // 否则基于 workspace 拼接
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(workspace, filePath)
  return path.normalize(abs)
}

/**
 * 判断 resolved 是否落在 workspace 目录内
 * - 相同目录 ✅
 * - 子目录 ✅
 * - 穿越到上级 ❌
 */
export function isWithinWorkspace(resolved: string, workspace: string): boolean {
  const normResolved = path.normalize(resolved)
  const normWorkspace = path.normalize(workspace)

  // 相同目录
  if (normResolved === normWorkspace) return true

  // 必须以 workspace 路径开头（含尾部斜杠），防止 /foo 匹配 /foobar
  const withSep = normWorkspace.endsWith(path.sep)
    ? normWorkspace
    : normWorkspace + path.sep
  return normResolved.startsWith(withSep)
}

/**
 * 校验文件可写（用于 write/edit 工具）
 * - 路径必须在 workspace 内
 * - 如果文件已存在，必须是文件而非目录
 */
export function assertWritable(filePath: string, workspace: string): void {
  const resolved = resolvePath(workspace, filePath)
  if (!isWithinWorkspace(resolved, workspace)) {
    throw new Error(
      `路径越界: "${filePath}" 解析为 "${resolved}"，不在工作目录 "${workspace}" 内`
    )
  }
  // 如果文件已存在，检查是否是目录
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      throw new Error(`路径 "${filePath}" 是一个目录，无法写入`)
    }
  }
}

/**
 * 校验文件可读（用于 read/grep 工具）
 * - 路径必须在 workspace 内
 * - 文件必须存在且是文件
 */
export function assertReadable(filePath: string, workspace: string): void {
  const resolved = resolvePath(workspace, filePath)
  if (!isWithinWorkspace(resolved, workspace)) {
    throw new Error(
      `路径越界: "${filePath}" 解析为 "${resolved}"，不在工作目录 "${workspace}" 内`
    )
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`文件不存在: "${filePath}"`)
  }
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) {
    throw new Error(`路径 "${filePath}" 不是文件`)
  }
}
