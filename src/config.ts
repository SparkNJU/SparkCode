// config.ts — 配置解析（环境变量 + CLI 参数）

import { resolve } from 'node:path'

export interface SparkConfig {
  model: string
  provider: {
    baseURL: string
    apiKeyEnv: string
  }
  maxStepsPerTurn: number
  maxToolResultChars: number
  maxContextTokens: number
  sandbox: {
    workspaceOnly: boolean
    approvalForOutside: boolean
  }
  shell: { timeoutMs: number; maxOutputChars: number }
  web: { host: string; port: number }
  workspace: string
  oneShotTask?: string
  printMode: boolean
  noColor: boolean
}

export function loadConfig(argv: string[]): SparkConfig {
  const args = argv.slice(2) // 去掉 node 和脚本路径

  // 解析 CLI 参数
  let modelOverride: string | undefined
  let workspaceOverride: string | undefined
  let printMode = false
  let noColor = false
  const taskParts: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-m':
      case '--model':
        modelOverride = args[++i]
        break
      case '-w':
      case '--workspace':
      case '--dir':
      case '--workdir':
        workspaceOverride = args[++i]
        break
      case '-p':
      case '--print':
        printMode = true
        break
      case '--no-color':
        noColor = true
        break
      case '-h':
      case '--help':
        printUsage()
        process.exit(0)
        break
      default:
        if (arg && !arg.startsWith('-')) {
          taskParts.push(arg)
        }
        break
    }
  }

  // 环境变量
  const env = process.env

  // API Key 检查
  const apiKeyEnv = 'SPARK_OPENAI_API_KEY'
  if (!env[apiKeyEnv]) {
    console.error('错误：未设置环境变量 SPARK_OPENAI_API_KEY')
    console.error('请在 .env 文件或系统环境变量中配置：')
    console.error('  SPARK_OPENAI_API_KEY=sk-your-key-here')
    process.exit(1)
  }

  const model = modelOverride ?? env['SPARK_MODEL'] ?? 'deepseek-chat'
  const baseURL = env['SPARK_BASE_URL'] ?? 'https://api.deepseek.com'
  const workspace = resolve(workspaceOverride ?? env['SPARK_WORKSPACE'] ?? process.cwd())

  return {
    model,
    provider: { baseURL, apiKeyEnv },
    maxStepsPerTurn: 50,
    maxToolResultChars: 20_000,
    maxContextTokens: 100_000,
    sandbox: { workspaceOnly: true, approvalForOutside: true },
    shell: { timeoutMs: 60_000, maxOutputChars: 200_000 },
    web: { host: 'localhost', port: 3080 },
    workspace,
    oneShotTask: taskParts.length > 0 ? taskParts.join(' ') : undefined,
    printMode,
    noColor,
  }
}

function printUsage(): void {
  console.log(`
Spark Code — 编程智能体

用法:
  spark [options] [task...]

选项:
  -m, --model <model>        指定模型
  -w, --dir <dir>            工作目录（默认当前目录）
  -p, --print                打印最终结果后退出（one-shot 模式）
  --no-color                 禁用颜色
  -h, --help                 帮助

环境变量:
  SPARK_OPENAI_API_KEY       API Key（必填）
  SPARK_BASE_URL             OpenAI 兼容网关地址
  SPARK_MODEL                默认模型
  SPARK_WORKSPACE            默认工作目录

示例:
  spark                      交互式 REPL
  spark -p "修复测试"         one-shot 模式
  spark -m gpt-4o "优化性能"  指定模型
`.trim())
}
