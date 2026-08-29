// tools/bash.ts — Shell 执行工具

import { spawn } from 'node:child_process'
import type { ToolDefinition, ToolResult, ToolRunContext } from './types.js'

export const bashTool: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'bash',
      description: '在工作目录执行一条 bash 命令，返回 stdout、stderr 与退出码。用于运行测试、构建、安装依赖、git 操作等。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的完整 bash 命令',
          },
          timeout_ms: {
            type: 'integer',
            description: '超时毫秒，默认 60000',
            default: 60000,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const command = (args as { command?: string }).command ?? ''
    const timeoutMs = (args as { timeout_ms?: number }).timeout_ms ?? 60_000

    if (!command.trim()) {
      return { content: 'Error: empty command', isError: true }
    }

    return runForeground(command, ctx, timeoutMs)
  },
}

async function runForeground(
  command: string,
  ctx: ToolRunContext,
  timeoutMs: number,
): Promise<ToolResult> {
  // Windows 兼容：使用 cmd /c；Unix 使用 /bin/bash -lc
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'cmd' : '/bin/bash'
  const shellArgs = isWin ? ['/c', command] : ['-lc', command]

  const proc = spawn(shell, shellArgs, {
    cwd: ctx.cwd,
    env: { ...process.env, SPARK_CWD: ctx.cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  proc.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })

  proc.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })

  // 取消支持：abort → kill 进程
  const onAbort = () => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // 进程可能已退出
    }
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  // 超时控制
  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, timeoutMs)

  // 等待进程结束
  const exitCode: number | null = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code))
    proc.on('error', () => resolve(null))
  })

  clearTimeout(timer)
  ctx.signal.removeEventListener('abort', onAbort)

  // 渲染输出
  const text = renderShellOutput(exitCode, stdout, stderr)
  const isError = exitCode !== 0 && exitCode !== null

  // 截断过长输出
  return {
    content: truncate(text, 20_000),
    isError,
    meta: { exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
  }
}

function renderShellOutput(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = []

  if (stdout) {
    parts.push(stdout)
  }
  if (stderr) {
    if (parts.length) parts.push('\n--- stderr ---\n')
    parts.push(stderr)
  }

  parts.push(`\n[exit code: ${exitCode ?? 'null'}]`)

  return parts.join('')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.8))
  const tail = text.slice(-Math.floor(max * 0.2))
  return `${head}\n\n…[输出已截断，共 ${text.length} 字符]…\n\n${tail}`
}
