#!/usr/bin/env node

// index.ts — CLI 入口 + REPL

import 'dotenv/config'  // 加载 .env 文件（必须在最前面）

import * as readline from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { loadConfig } from './config.js'
import { Context } from './core/context.js'
import { LlmAdapter } from './core/llm.js'
import { SparkAgent } from './core/loop.js'
import { ToolRegistry } from './tools/registry.js'
import { bashTool } from './tools/bash.js'
import { readTool, writeTool, editTool } from './tools/fs.js'
import { globTool, grepTool } from './tools/search.js'
import type { ToolResult } from './tools/types.js'
import type { SparkConfig } from './config.js'

async function main(): Promise<void> {
  // 1. 解析配置
  const config = loadConfig(process.argv)

  // 2. 创建核心服务
  const ctx = createContext(config)

  // 3. 创建 Agent
  const agent = new SparkAgent(ctx, config)

  // 4. CLI 模式分支
  if (config.oneShotTask) {
    await runOneShot(agent, config)
  } else {
    await runRepl(agent, config)
  }
}

/** 创建核心服务上下文 */
function createContext(config: SparkConfig): Context {
  const ctx = new Context()
  const apiKey = process.env[config.provider.apiKeyEnv]
  if (!apiKey) {
    console.error('错误：未找到 API Key')
    process.exit(1)
  }

  const llm = new LlmAdapter({
    apiKey,
    baseURL: config.provider.baseURL,
    ctx,
  })

  ctx.provide('llm', llm)
  ctx.provide('config', config)

  // 注册工具
  const tools = new ToolRegistry()
  tools.register(bashTool)
  tools.register(readTool)
  tools.register(writeTool)
  tools.register(editTool)
  tools.register(globTool)
  tools.register(grepTool)
  ctx.provide('tools', tools)

  // M4: 注册压缩事件监听（供 TUI 显示）
  ctx.events.on('compact/done', (data: { originalTokens: number; summaryTokens: number; cutIndex: number }) => {
    if (config.printMode) return // one-shot 模式不打印压缩信息
    const saved = data.originalTokens - data.summaryTokens
    console.log(`\n📦 上下文已压缩：${data.originalTokens} → ${data.summaryTokens} token（节省 ${saved} token）`)
  })

  return ctx
}

/** one-shot 模式：执行任务 → 打印结果 → 退出 */
async function runOneShot(agent: SparkAgent, config: SparkConfig): Promise<void> {
  let finalText = ''

  // 订阅 assistant/chunk 收集最终文本
  agent.ctx.events.on<{ turn: number; step: number; chunk: { kind: string; text?: string } }>(
    'assistant/chunk',
    (data) => {
      if (data.chunk.kind === 'content' && data.chunk.text) {
        finalText += data.chunk.text
        if (!config.printMode) {
          stdout.write(data.chunk.text)
        }
      }
    },
  )

  agent.followup(config.oneShotTask!)
  await agent.waitForTurnEnd()

  if (config.printMode) {
    stdout.write(finalText + '\n')
  }
}

/** 直接执行 Shell 命令（不经过 LLM） */
async function executeDirectCommand(
  tools: ToolRegistry,
  command: string,
  config: SparkConfig,
): Promise<void> {
  const color = config.noColor ? '' : '\x1b[36m'
  const reset = config.noColor ? '' : '\x1b[0m'
  stdout.write(`${color}$ ${command}${reset}\n`)

  const result: ToolResult = await tools.execute(
    { id: 'direct', name: 'bash', args: { command } },
    {
      signal: AbortSignal.timeout(60_000),
      agent: null as any,
      cwd: config.workspace,
      deferContext: () => {},
      writeEvent: () => {},
    },
  )

  if (result.isError) {
    const errColor = config.noColor ? '' : '\x1b[31m'
    stdout.write(`${errColor}${result.content}${reset}\n`)
  } else {
    stdout.write(`${result.content}\n`)
  }
}

/** 交互式 REPL */
async function runRepl(agent: SparkAgent, config: SparkConfig): Promise<void> {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  })

  let interruptCount = 0

  // Ctrl+C 处理
  let cancelled = false
  const onSigint = (): void => {
    if (!cancelled) {
      cancelled = true
      agent.cancel('user-interrupt')
      stdout.write('\n(已退出)\n')
      rl.close()
    }
    // 二次 Ctrl+C 直接强制退出
    process.exit(0)
  }

  process.on('SIGINT', onSigint)

  // 事件渲染
  setupEventRendering(agent, config)

  // 打印欢迎信息
  stdout.write(`\n  Spark Code — 编程智能体\n`)
  stdout.write(`  模型: ${config.model}\n`)
  stdout.write(`  工作目录: ${config.workspace}\n`)
  stdout.write(`  输入任务开始对话，!命令 直接执行 Shell，Ctrl+C 退出\n`)
  stdout.write(`  /compact 手动压缩上下文，/help 查看帮助\n\n`)

  // REPL 循环
  while (true) {
    try {
      const input = await rl.question('> ')
      interruptCount = 0 // 重置中断计数

      const trimmed = input.trim()
      if (!trimmed) continue
      if (trimmed === '/exit' || trimmed === '/quit') break

      // M4: 手动触发上下文压缩（与 Claude Code /compact 对齐）
      if (trimmed === '/compact') {
        const messages = agent.session.deriveMessages()
        const log = agent.session.getLog()
        stdout.write(`\n📊 上下文状态：\n`)
        stdout.write(`  消息数：${messages.length}\n`)
        stdout.write(`  事件数：${log.length}\n`)
        stdout.write(`  触发自动压缩阈值：${config.compaction.threshold} token\n`)
        stdout.write(`\n🔄 手动触发压缩...\n`)
        // 调用 agent 的公开方法触发压缩
        await (agent as any).maybeCompactContext()
        const afterMessages = agent.session.deriveMessages()
        stdout.write(`  压缩后消息数：${afterMessages.length}\n\n`)
        continue
      }

      // 帮助命令
      if (trimmed === '/help' || trimmed === '/?') {
        stdout.write(`\n  可用命令：\n`)
        stdout.write(`  /compact    手动触发上下文压缩\n`)
        stdout.write(`  /exit       退出\n`)
        stdout.write(`  !命令       直接执行 Shell（如 !ls）\n\n`)
        continue
      }

      // 命令模式：! 前缀 → 直接执行 Shell，不经过 LLM
      if (trimmed.startsWith('!')) {
        const command = trimmed.slice(1).trim()
        if (command) {
          await executeDirectCommand(agent.tools, command, config)
        }
        continue
      }

      // 对话模式：走 LLM
      agent.followup(trimmed)
      await agent.waitForTurnEnd()
      stdout.write('\n')
    } catch {
      // readline 被关闭（Ctrl+C 或 /exit）
      break
    }
  }

  process.removeListener('SIGINT', onSigint)
  rl.close()
}

/** 设置事件渲染（纯函数渲染，与 Web 共用逻辑） */
function setupEventRendering(agent: SparkAgent, config: SparkConfig): void {
  const ctx = agent.ctx

  // assistant/chunk → 流式打印文本
  ctx.events.on<{ turn: number; step: number; chunk: { kind: string; text?: string } }>(
    'assistant/chunk',
    (data) => {
      if (data.chunk.kind === 'content' && data.chunk.text) {
        stdout.write(data.chunk.text)
      }
    },
  )

  // tool/call → 工具调用提示（M1 不触发，M2 启用）
  ctx.events.on<{ name: string; arguments: string }>(
    'tool/call',
    (data) => {
      const color = config.noColor ? '' : '\x1b[36m' // cyan
      const reset = config.noColor ? '' : '\x1b[0m'
      stdout.write(`\n${color}🔧 ${data.name}(${truncate(data.arguments, 100)})${reset}\n`)
    },
  )

  // tool/result → 工具结果（M1 不触发）
  ctx.events.on<{ message: { content: string; isError: boolean } }>(
    'tool/result',
    (data) => {
      const isError = data.message.isError
      const color = config.noColor ? '' : isError ? '\x1b[31m' : '\x1b[32m' // red/green
      const reset = config.noColor ? '' : '\x1b[0m'
      const prefix = isError ? '✗' : '✓'
      const content = truncate(data.message.content, 500)
      stdout.write(`${color}${prefix} ${content}${reset}\n`)
    },
  )

  // turn/end → 回合结束状态
  ctx.events.on<{ turn: number; reason: { kind: string } }>(
    'turn/end',
    (data) => {
      if (data.reason.kind === 'error') {
        const color = config.noColor ? '' : '\x1b[31m'
        const reset = config.noColor ? '' : '\x1b[0m'
        stdout.write(`\n${color}✗ 回合出错${reset}\n`)
      }
    },
  )
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

// 启动
main().catch((error) => {
  stderr.write(`\n致命错误: ${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
})
