Git 仓库：https://github.com/SparkNJU/SparkCode

=== 如何运行 ===

环境要求：Node.js >= 20，OpenAI 兼容 API Key

1. git clone https://github.com/SparkNJU/SparkCode.git
2. cd SparkCode && npm install
3. export SPARK_OPENAI_API_KEY=sk-xxx
4. npm run spark（交互模式）
   npm run spark -- -p "你的任务"（单次模式）

也可通过项目根目录 .env 文件配置（cp .env.example .env 后编辑）。
可选：SPARK_BASE_URL（默认 DeepSeek）、SPARK_MODEL（默认 deepseek-chat）

=== 项目简介 ===

Spark Code 是一个从零实现的编程智能体，通过与大语言模型多轮交互，自主读写文件、执行命令，完成编程任务。全部重要逻辑自行编写，不使用任何 agent 框架/SDK（LangChain、LlamaIndex、OpenAI Agents SDK 等），仅依赖 openai 客户端库。

=== 特色功能 ===

1. 自研 Agent 循环：turn/step 状态机，四层终止条件（自然结束、步数上限、输入耗尽、用户取消），防死循环。

2. 事件日志架构：所有状态以 append-only 事件日志保存，支持重放、审计、压缩。持久化 = 存日志，恢复 = 重放日志。

3. 工具系统：统一注册表 + 执行管道，内置 bash、文件读写编辑、glob/grep 搜索。工具失败不抛异常，返回结构化结果让模型自主修正。

4. 流式输出解析：自研 SSE 增量分类器 + tool-call arguments 分片聚合器，支持分片 JSON 拼接与容错。

5. 上下文管理：自动 token 计量，工具结果截断 + 摘要压缩（两级），长对话不爆上下文。

6. 会话持久化：JSONL 事件日志落盘，支持多会话管理与恢复续接。

7. 命令系统：/model 切换模型，/plan 只读分析，/auto 全自动，/effort 控制推理深度，自定义 Skill 模板，Tab 补全。

8. Inline TUI：纯 ANSI 实现，零 TUI 依赖。Braille 思考动画、代码块折叠（Ctrl+O 展开）、Markdown 终端渲染、顶部状态栏。

=== 技术栈 ===

TypeScript / Node.js / openai npm 包 / Vitest
约 5500 行代码，49 个源文件
