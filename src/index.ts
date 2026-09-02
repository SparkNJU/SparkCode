#!/usr/bin/env node

// index.ts — CLI 入口 + REPL

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'

// 从项目源码目录加载 .env（npm link 后工作目录会变化）
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: resolve(__dirname, '../.env') })

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
import { showSessionPicker } from './persist/picker.js'
import { CommandRegistry, registerBuiltinCommands, registerModelCommand, registerModeCommands, registerEffortCommand, registerSkillCommands, loadModelPresets } from './commands/index.js'
import { createCompleter, buildPrompt } from './ui/index.js'

async function main(): Promise<void> {
  // 1. 解析配置
  const config = loadConfig(process.argv)

  // 2. 创建核心服务
  const ctx = createContext(config)

  // 3. 创建 Agent
  const agent = new SparkAgent(ctx, config)

  // 4. M5: 解析 --resume 参数
  const args = process.argv.slice(2)
  const resumeIdx = args.indexOf('--resume')
  let startMode: 'new' | 'picker' | 'latest' | 'specific' = 'new'
  let specificId: string | null = null

  if (resumeIdx !== -1) {
    const resumeArg = args[resumeIdx + 1]
    if (!resumeArg || resumeArg.startsWith('-')) {
      startMode = 'picker'           // spark --resume → 打开 Picker
    } else if (resumeArg === 'latest') {
      startMode = 'latest'           // spark --resume latest
    } else {
      startMode = 'specific'         // spark --resume <id>
      specificId = resumeArg
    }
  }

  // 5. CLI 模式分支
  if (config.oneShotTask) {
    // one-shot 模式：启用持久化后执行任务
    agent.enablePersistence()
    await runOneShot(agent, config)
    agent.saveCurrentMeta()
  } else if (startMode !== 'new') {
    // M5: 恢复会话模式
    await runResumeMode(agent, config, startMode, specificId)
  } else {
    // 正常 REPL 模式：新建会话
    agent.enablePersistence()
    await runRepl(agent, config)
    agent.saveCurrentMeta()
  }
}

/** M5: 恢复会话模式 */
async function runResumeMode(
  agent: SparkAgent,
  config: SparkConfig,
  mode: 'picker' | 'latest' | 'specific',
  specificId: string | null,
): Promise<void> {
  const store = agent.getStore()

  switch (mode) {
    case 'latest': {
      const latestId = store.getLatestId()
      if (latestId) {
        await agent.resume(latestId)
        console.log(`📂 已恢复最近会话: ${latestId}`)
        await runRepl(agent, config)
        agent.saveCurrentMeta()
      } else {
        console.log('📭 没有历史会话，创建新会话')
        agent.enablePersistence()
        await runRepl(agent, config)
        agent.saveCurrentMeta()
      }
      break
    }

    case 'specific': {
      try {
        await agent.resume(specificId!)
        console.log(`📂 已恢复会话: ${specificId}`)
        await runRepl(agent, config)
        agent.saveCurrentMeta()
      } catch {
        console.log(`⚠️  会话 ${specificId} 不存在，打开选择器...`)
        // 启动时还没有 runRepl 的 rl，创建临时 readline
        const tempRl = readline.createInterface({ input: stdin, output: stdout, terminal: true })
        const result = await showSessionPicker(store.list(), tempRl, stdout)
        tempRl.close()
        // 处理删除
        for (const deletedId of result.deletedIds) {
          agent.deleteSession(deletedId)
        }
        if (result.action === 'select' && result.sessionId) {
          await agent.resume(result.sessionId)
          await runRepl(agent, config)
          agent.saveCurrentMeta()
        } else {
          agent.enablePersistence()
          await runRepl(agent, config)
          agent.saveCurrentMeta()
        }
      }
      break
    }

    case 'picker': {
      // 启动时还没有 runRepl 的 rl，创建临时 readline
      const tempRl = readline.createInterface({ input: stdin, output: stdout, terminal: true })
      const result = await showSessionPicker(store.list(), tempRl, stdout)
      tempRl.close()
      // 处理删除
      for (const deletedId of result.deletedIds) {
        agent.deleteSession(deletedId)
      }
      if (result.action === 'select' && result.sessionId) {
        await agent.resume(result.sessionId)
        console.log(`📂 已恢复会话: ${result.sessionId}`)
        await runRepl(agent, config)
        agent.saveCurrentMeta()
      } else {
        // 取消 → 新建会话
        agent.enablePersistence()
        await runRepl(agent, config)
        agent.saveCurrentMeta()
      }
      break
    }
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

/** 创建并注册命令系统 */
async function createCommandSystem(agent: SparkAgent, config: SparkConfig): Promise<CommandRegistry> {
  const registry = new CommandRegistry()

  const ctx = {
    agent,
    config,
    cwd: config.workspace,
    print: (text: string) => stdout.write(text + '\n'),
  }

  // 注册内置命令
  registerBuiltinCommands(registry)

  // 注册模型切换命令
  const presets = loadModelPresets()
  registerModelCommand(registry, presets)

  // 注册模式切换命令
  registerModeCommands(registry)

  // 注册 Effort 命令
  registerEffortCommand(registry)

  // 注册 Skill 命令
  await registerSkillCommands(registry, config.workspace)

  return registry
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
  // M6: 创建命令系统
  const registry = await createCommandSystem(agent, config)

  // M6: 创建 Tab 补全
  const completer = createCompleter(registry)

  let rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    completer,
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
  stdout.write(`  模型: ${agent.currentModel}\n`)
  stdout.write(`  工作目录: ${config.workspace}\n`)
  stdout.write(`  会话ID: ${agent.session.id}\n`)
  stdout.write(`  输入任务开始对话，!命令 直接执行 Shell，Ctrl+C 退出\n`)
  stdout.write(`  /help 查看帮助 | /model 切换模型 | /plan 规划模式 | Tab 补全命令\n\n`)

  // REPL 循环
  while (true) {
    try {
      // M6: 动态提示符
      const prompt = buildPrompt(agent)
      rl.setPrompt(prompt)
      const input = await rl.question(prompt)
      interruptCount = 0 // 重置中断计数

      const trimmed = input.trim()
      if (!trimmed) continue
      if (trimmed === '/exit' || trimmed === '/quit') break

      // M6: 命令系统处理
      const commandCtx = {
        agent,
        config,
        cwd: config.workspace,
        print: (text: string) => stdout.write(text + '\n'),
      }
      const handled = await registry.execute(trimmed, commandCtx)
      if (handled) continue

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

  // 退出时保存元数据
  agent.saveCurrentMeta()
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
