# Spark Code

> 从零实现的编程智能体 — 不依赖任何 agent 框架/SDK

**仓库地址**：https://github.com/SparkNJU/SparkCode

---

## 简介

Spark Code 是一个独立设计并实现的编程智能体（coding agent）。它通过与大语言模型多轮交互，自主读写文件、执行 Shell 命令，完成用户交付的编程任务。类似一个简化的 Claude Code / Codex / DeepSeek Harness。

**核心特点**：全部重要逻辑自行编写，不使用任何 agent 框架（LangChain / LlamaIndex / OpenAI Agents SDK 等），仅依赖模型厂商的 API 客户端库。

---

## 快速开始

### 环境要求

- Node.js ≥ 20
- OpenAI 兼容的 API Key（DeepSeek / OpenAI / 其他兼容服务）

### 安装

```bash
git clone https://github.com/SparkNJU/SparkCode.git
cd SparkCode
npm install
```

### 配置

支持环境变量或项目根目录 `.env` 文件两种方式（`.env` 优先级更高，已加入 `.gitignore`）：

```bash
# 方式一：环境变量
export SPARK_OPENAI_API_KEY=sk-xxx

# 方式二：.env 文件（项目根目录）
cp .env.example .env
# 编辑 .env 填入你的 API Key
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `SPARK_OPENAI_API_KEY` | 是 | API Key |
| `SPARK_BASE_URL` | 否 | OpenAI 兼容网关地址（默认 DeepSeek） |
| `SPARK_MODEL` | 否 | 默认模型（默认 deepseek-chat） |

### 运行

```bash
# 交互式模式
npm run spark

# One-shot 模式（执行任务后退出）
npm run spark -- -p "运行 ls 命令并解释输出"

# 恢复上次会话
npm run spark -- --resume latest
```

---

## 功能特性

### 核心能力
- **多轮对话**：与 LLM 流式交互，自主决定何时调用工具
- **Shell 执行**：运行任意命令，支持前台/后台执行、超时控制
- **文件操作**：读取、写入、精确编辑（字符串替换 + diff 预览）
- **代码搜索**：glob 文件匹配 + grep 正则搜索
- **上下文管理**：自动 token 计量、工具结果裁剪、摘要压缩，长对话不爆上下文
- **会话持久化**：JSONL 事件日志落盘，支持恢复/续接

### 交互体验（TUI）
- **Inline TUI**：纯 ANSI 实现，零第三方 TUI 依赖
- **Braille spinner**：思考动画 + 推理内容实时预览
- **代码块折叠**：自动折叠长代码块，Ctrl+O 展开/收起
- **Markdown 渲染**：标题、粗体、代码块、表格、列表的终端渲染
- **状态栏**：顶部固定显示模型、模式、token 用量、工作目录

### 命令系统
- `/model` — 运行时切换模型
- `/plan` `/auto` `/normal` — 切换交互模式（只读分析 / 全自动 / 普通）
- `/effort low|medium|high` — 控制推理深度
- `/skill-name` — 自定义 Skill（`.spark/commands/*.md` 模板）
- Tab 补全 — 输入 `/` 后自动补全命令

---

## 架构设计

```
src/
├── index.ts           # 入口：CLI 参数解析 + REPL 主循环
├── config.ts          # 配置解析（环境变量 + CLI 参数）
├── core/              # 核心运行时
│   ├── session.ts     # 事件日志（唯一事实源）+ 消息投影
│   ├── loop.ts        # Agent 循环（turn/step 状态机）
│   ├── llm.ts         # LLM 适配器（流式调用 + chunk 解析）
│   ├── prompt.ts      # 系统提示词组装
│   ├── inbox.ts       # 消息队列
│   └── context.ts     # 事件总线 + 服务仓库
├── tools/             # 工具系统
│   ├── registry.ts    # 工具注册表 + 执行管道
│   ├── bash.ts        # Shell 执行
│   ├── fs.ts          # 文件读写编辑
│   └── search.ts      # glob/grep 搜索
├── ui/                # TUI 界面
│   ├── inline-renderer.ts   # 流式渲染器
│   ├── status-bar.ts        # 状态栏
│   ├── markdown.ts          # Markdown 终端渲染
│   └── banner.ts            # 欢迎横幅
├── compact/           # 上下文压缩
├── persist/           # JSONL 持久化
├── commands/          # 命令系统
└── skills/            # 自定义 Skill 加载
```

**设计哲学**：
1. **事件日志是唯一事实源** — 一切状态以 append-only 事件保存，支持重放、审计、压缩
2. **工具即注册表** — 所有能力注册进 ToolRegistry，schema 自动汇入 prompt
3. **UI 是事件的纯函数** — TUI 只订阅事件流渲染，不参与决策

---

## 技术栈

| 类别 | 选型 |
|------|------|
| 语言 | TypeScript（strict 模式） |
| 运行时 | Node.js ≥ 20 |
| 模型 API | `openai` 官方 npm 包（OpenAI 兼容网关） |
| 终端 UI | 纯 ANSI Escape Codes + `chalk` |
| 测试 | Vitest |

---

## 测试

```bash
npm test
```

---

## 许可证

[MIT](LICENSE)
