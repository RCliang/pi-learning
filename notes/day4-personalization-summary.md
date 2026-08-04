# Day 4 笔记：PI 的 5 个个性化面（验证总结）

> 验证日期：2026-08-04
> 验证环境：PI v0.83.0，Node v22.19.0，ZAI/glm-4.6 模型
> 验证目录：`E:\2026projects\pi-learning\playground\`

## 速查表

| # | 个性化面 | 位置 | 注入方式 | 验证状态 |
|---|---|---|---|---|
| 1 | Context Files | `AGENTS.md` / `CLAUDE.md`（cwd+祖先遍历） | `<project_context>` XML 块 | ✅ |
| 2 | System Prompt 重写 | `.pi/SYSTEM.md`（替换）/ `.pi/APPEND_SYSTEM.md`（追加） | 直接拼接 | ✅ |
| 3 | Skills | `.pi/skills/*.md`（YAML frontmatter） | `<available_skills>` XML（渐进式披露） | ✅ |
| 4 | Settings | `.pi/settings.json`（项目）/ `~/.pi/agent/settings.json`（全局） | 影响 agent 行为参数 | ✅ |
| 5 | Extensions | `.pi/extensions/*.ts`（jiti 即时编译） | 40+ 生命周期钩子 + 注册 API | ✅ |

---

## Face 1: Context Files (AGENTS.md)

**机制**：PI 启动时扫描 cwd 及其祖先目录的 `AGENTS.md` / `CLAUDE.md`，内容注入到 system prompt 的 `<project_context><project_instructions path="...">` XML 块。

**验证**：写了 `playground/AGENTS.md`，规定"中文回复 + 【已读规范】暗号 + TS/Node/Vitest 栈"。模型回复正确遵守全部规则。

**关键源码**：`system-prompt.ts:144-152`（contextFiles 注入逻辑）

**坑**：模型在多个规则冲突时，AGENTS.md 的优先级高于 APPEND_SYSTEM.md（实测确认）。

---

## Face 2: System Prompt Overrides (SYSTEM.md / APPEND_SYSTEM.md)

**机制**：
- `.pi/SYSTEM.md` 存在 → **完全替换**默认 system prompt（`buildSystemPrompt` 的 `customPrompt` 分支）
- `.pi/APPEND_SYSTEM.md` 存在 → **追加**到默认 prompt 末尾（`appendSection`）

**验证**：写 APPEND_SYSTEM.md 要求"每次回复开头说【个性化已激活】"，模型回复"【已读规范】\n\n1+1=2"——证明两份文件都注入了，模型在冲突时选择了 AGENTS.md 的暗号。

**关键源码**：`system-prompt.ts:46-72`（customPrompt 分支）、`agent-session.ts:1037-1040`（resourceLoader 读取）

---

## Face 3: Skills (Progressive Disclosure)

**机制**（这是 PI 最精巧的设计之一）：
1. 启动时扫描 `.pi/skills/*.md` 和 `~/.pi/agent/skills/`，解析 YAML frontmatter
2. **只把 name + description + location 注入** `<available_skills>` XML 块（progressive disclosure）
3. **完整内容不注入**！模型需要时用 `read` 工具按 location 读取文件

**验证**：
- `loadSkills()` 发现了 `code-review-checklist.md` ✅
- `formatSkillsForPrompt()` 输出确认只有 name/desc/location，正文 376 字符未泄露 ✅
- 命名校验：写 `Invalid_Name` 测试，正确产生 warning diagnostic ✅
- 端到端：模型**未自动 read skill**——但这是**官方文档化的行为**（"models don't always do this"）

**关键认知**：
- Progressive disclosure 的本质是**省 token**——10 个 skill 各 500 字 = 5000 字，但只注入 ~50 字/skill
- 代价：模型可能"偷懒"不读 skill。强制触发方式：①prompting（"用 xxx skill"）②`/skill:name`
- name 规则：`^[a-z0-9-]+$`，不能 `-` 开头/结尾，不能 `--`

**关键源码**：`skills.ts:168-275`（loadSkillsFromDir 发现逻辑）、`skills.ts:335-361`（formatSkillsForPrompt）

---

## Face 4: Settings (settings.json)

**机制**：
- 全局：`~/.pi/agent/settings.json`
- 项目：`<cwd>/.pi/settings.json`
- 合并：`deepMergeSettings(global, project)` —— **project 覆盖 global**
- 嵌套对象递归合并；**数组整体替换**（不合并元素）

**验证**：
- 合并优先级单元测试：7 项全过 ✅
- 运行时验证：项目 `defaultThinkingLevel: "low"` 覆盖全局 `"high"` ✅

**🔥 关键发现：PI 的信任安全模型**
- **未信任的项目目录**：`.pi/settings.json` **完全不加载**（`loadFromStorage` 直接 `return {}`）
- 信任记录在 `~/.pi/agent/trust.json`
- 首次进入新目录会询问"Trust / Trust parent / Do not trust"
- 这防止恶意项目通过 `.pi/settings.json` 篡改 `httpProxy`、`shellPath` 等敏感配置

**50+ 字段分类**：
- 模型：`defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` / `thinkingBudgets`
- Agent：`compaction` / `retry` / `steeringMode` / `followUpMode`
- 工具：`packages` / `extensions` / `skills` / `prompts` / `enableSkillCommands`
- 网络：`transport` / `httpProxy` / `httpIdleTimeoutMs` / `shellPath`

**关键源码**：`settings-manager.ts:86-134`（Settings 接口）、`settings-manager.ts:137-165`（deepMergeSettings）、`settings-manager.ts:loadFromStorage`（trust guard）

---

## Face 5: Extensions (Lifecycle Hooks) ⭐ 最强大

**机制**：
- 扫描 `.pi/extensions/*.ts`，用 **jiti 即时编译**（无需 build 步骤！）
- 默认导出一个 `(pi: ExtensionAPI) => void` 函数
- 在函数内通过 `pi.on(event, handler)` 注册钩子，`pi.registerTool/Command/Flag` 注册资源

**验证**：写了 `token-logger.ts`，监听：
- `session_start` → notify 加载成功
- `message_end` → stderr 打印 token 用量（input/output/cache/total/cost）
- `tool_execution_start` → 追踪工具调用
- `session_shutdown` → 汇总

实测输出：
```
[token-logger] zai-coding-cn/glm-4.6 | input=116 output=128 cache=7168 total=7412
[token-logger] 🔧 tool #1: read
[token-logger] zai-coding-cn/glm-4.6 | input=203 output=148 cache=7296 total=7647
[token-logger] 会话结束，共 1 次工具调用
```

**ExtensionAPI 能力清单**（`extensions/types.ts`）：

| 类别 | API | 用途 |
|---|---|---|
| 事件订阅 | `on(event, handler)` | 40+ 生命周期钩子 |
| 工具注册 | `registerTool(ToolDefinition)` | 让 LLM 调用自定义工具 |
| 命令注册 | `registerCommand(name, opts)` | 加 `/命令` |
| 快捷键 | `registerShortcut(key, opts)` | 加键盘快捷键 |
| CLI 参数 | `registerFlag(name, opts)` | 加 `--flag` |
| 渲染 | `registerMessageRenderer/EntryRenderer` | 自定义 UI 渲染 |
| 消息 | `sendMessage/sendUserMessage` | 主动发消息触发 turn |
| 元数据 | `setSessionName/setLabel` | 会话标记 |
| Shell | `exec(cmd, args)` | 执行命令 |
| 工具管理 | `getActiveTools/setActiveTools` | 动态启停工具 |
| 模型 | `setModel/setThinkingLevel` | 切换模型/思考级别 |
| Provider | `registerProvider` | 注册自定义 LLM provider |
| 跨扩展 | `events.emit/on` | 扩展间事件总线 |

**最重要的钩子（按价值排序）**：
1. `before_agent_start` → 可返回 `{systemPrompt: string}` **替换该 turn 的 system prompt**（remember 扩展的核心入口！）
2. `message_end` → 拿到完整 assistant 消息（可提取事实、统计 token）
3. `tool_call` / `tool_result` → 拦截/修改工具调用
4. `before_provider_request` → 修改发给 LLM 的 payload
5. `session_before_compact` → 自定义压缩逻辑

**关键源码**：`extensions/types.ts:1195-1240`（on 重载列表）、`extensions/types.ts:1097-1101`（BeforeAgentStartEventResult）

---

## 总结：PI 个性化架构的哲学

1. **渐进式**（progressive）：从 "改个配置" → "写个 skill" → "写个 extension"，复杂度递增，能力递增
2. **惰性**（lazy）：skills 只注入描述、extensions 只在事件触发时运行——省 token、省性能
3. **可组合**（composable）：5 个面可以叠加使用，不冲突
4. **安全**（secure）：trust 机制防止恶意项目篡改
5. **零构建**（zero-build）：jiti 让 .ts 扩展即写即用——这是 DX 杀手锏

**最大的空白**：**没有跨会话长期记忆**。所有 5 个面都是"单会话内"或"静态配置"的。compaction 的 "Constraints & Preferences" 段落只限单会话。这正是 Stage 3 `remember` 扩展要填补的。
