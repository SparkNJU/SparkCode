// tools/bash.ts — Shell 执行工具

import { spawn } from 'node:child_process'
import type { ToolDefinition, ToolResult, ToolRunContext } from './types.js'

/**
 * 创建 shell 输出的流式解码器
 *
 * 使用 TextDecoder + { stream: true } 确保多字节字符（如 UTF-8 中文）
 * 跨 buffer chunk 边界时不会被截断。
 *
 * Windows 默认 UTF-8（现代 Windows Terminal / PowerShell 均输出 UTF-8）。
 * 可通过 SPARK_SHELL_ENCODING 环境变量覆盖（如 gbk）。
 */
function createShellDecoder(): {
  /** 流式解码（每个 chunk 调用，自动缓冲不完整的尾部字节） */
  decodeStream: (buf: Buffer) => string
  /** 结束时刷新剩余缓冲字节 */
  flush: () => string
} {
  const enc = process.env.SPARK_SHELL_ENCODING || 'utf-8'
  try {
    const decoder = new TextDecoder(enc)
    return {
      decodeStream: (buf: Buffer) => decoder.decode(buf, { stream: true }),
      flush: () => decoder.decode(), // 无参数 = 刷新缓冲
    }
  } catch {
    // TextDecoder 不支持该编码时回退 UTF-8
    const decoder = new TextDecoder('utf-8')
    return {
      decodeStream: (buf: Buffer) => decoder.decode(buf, { stream: true }),
      flush: () => decoder.decode(),
    }
  }
}

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
  const decoder = createShellDecoder()

  proc.stdout.on('data', (data: Buffer) => {
    stdout += decoder.decodeStream(data)
  })

  proc.stderr.on('data', (data: Buffer) => {
    stderr += decoder.decodeStream(data)
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

  // 刷新解码器缓冲区（处理末尾不完整的多字节字符）
  stdout += decoder.flush()
  stderr += decoder.flush()

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
