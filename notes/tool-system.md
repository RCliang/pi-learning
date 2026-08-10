# PI 工具系统：设计、加载与扩展

> 对应源码：`packages/agent/src/harness/tools/`、`packages/coding-agent/src/core/tools/`、`packages/coding-agent/src/core/agent-session.ts`、`packages/coding-agent/src/core/extensions/types.ts`

---

## 一、全景：7 个内置工具

PI 的 coding-agent 内置 **7 个工具**，全部在 `packages/coding-agent/src/core/tools/index.ts` 中注册：

```typescript
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
```

| 工具 | 作用 | 只读？ | 外部依赖 | 默认激活 |
|------|------|--------|----------|----------|
| **read** | 读文件（支持行偏移、图片、行号、截断） | ✅ | 无 | ✅ |
| **bash** | 执行 shell 命令（支持超时、后台运行） | ❌ | 无 | ✅ |
| **edit** | 精确字符串替换（old_string → new_string） | ❌ | 无 | ✅ |
| **write** | 写入/覆盖整个文件 | ❌ | 无 | ✅ |
| **grep** | 内容搜索（正则 + glob 过滤） | ✅ | **ripgrep (rg)** | ❌ |
| **find** | 文件名搜索（基于 fd） | ✅ | **fd** | ❌ |
| **ls** | 列目录内容 | ✅ | 无 | ❌ |

### 1.1 两个工具分组

PI 把工具分为两组（见 `index.ts`）：

```typescript
// 写代码组：4 个核心工具（默认激活）
export function createCodingToolDefinitions(cwd, options): ToolDef[] {
    return [read, bash, edit, write];  // 行 138-145
}

// 只读组：4 个搜索/浏览工具
export function createReadOnlyToolDefinitions(cwd, options): ToolDef[] {
    return [read, grep, find, ls];  // 行 147-154
}
```

> **设计意图**：默认只开 `read/bash/edit/write`（够写代码）。`grep/find/ls` 需要额外启用（`--tools grep,find` 或扩展动态注册），且依赖外部二进制 `rg`/`fd`。

### 1.2 各工具参数 Schema（精简版）

#### read
```
file_path: string     (必填，绝对路径)
offset?: number       (起始行号)
limit?: number        (读取行数)
```
- 截断策略：`DEFAULT_MAX_LINES = 2000`，`DEFAULT_MAX_BYTES = 30KB`
- 图片（PNG/JPG）自动以视觉形式返回

#### bash
```
command: string       (必填，shell 命令)
description?: string  (命令描述)
timeout?: number      (毫秒，默认 120000，上限 600000)
run_in_background?: boolean
dangerouslyDisableSandbox?: boolean
```

#### edit
```
file_path: string     (必填)
old_string: string    (必填，要替换的精确文本)
new_string: string    (必填，替换为)
replace_all?: boolean (默认 false)
```
- 唯一匹配约束：`old_string` 必须是文件中的**唯一匹配**，否则报错
- 前置条件：必须先 Read 该文件

#### write
```
file_path: string  (必填，绝对路径)
content: string    (必填，完整文件内容)
```
- 用于新建文件或完全覆盖

#### grep
```
pattern: string              (必填，正则)
path?: string                (搜索目录)
glob?: string | string[]     (文件名过滤)
output_mode?: "content" | "files_with_matches" | "count"
```
- 依赖 `rg`（ripgrep）

#### find
```
pattern: string    (必填，文件名 glob)
path?: string      (搜索根目录)
type?: "file" | "dir"
```
- 依赖 `fd`

#### ls
```
path: string  (必填，目录路径)
```

---

## 二、两层工具架构

PI 的工具分布在**两个 package 层**，这是理解整个系统的关键：

```
┌─────────────────────────────────────────────────────────┐
│  packages/coding-agent/src/core/tools/  ← 产品层         │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐     │
│  │ read │ bash │ edit │write │ grep │ find │  ls  │     │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘     │
│  特点：带 cwd 绑定、promptSnippet、promptGuidelines      │
│        有 ToolDefinition（定义层）和 AgentTool（运行时） │
└───────────────────────────┬─────────────────────────────┘
                            │ 底层能力继承自
                            ▼
┌─────────────────────────────────────────────────────────┐
│  packages/agent/src/harness/tools/  ← 通用层（pi-agent-core）│
│  ┌──────┬──────┬──────┬──────┬───────┐                  │
│  │ read │ bash │ edit │write │ image │                  │
│  └──────┴──────┴──────┴──────┴───────┘                  │
│  特点：无 cwd 绑定，通过 ExecutionToolContext 注入环境   │
│        是"裸"工具，被 AgentHarness 直接使用              │
└─────────────────────────────────────────────────────────┘
```

### 2.1 通用层（harness/tools）

**位置**：`packages/agent/src/harness/tools/`

这是 `pi-agent-core` 提供的**与产品无关**的基础工具。它们的特点：

- **不绑定 cwd**：通过 `ExecutionToolContext`（包含 `env.cwd()`、`env.readTextFile()` 等）注入运行环境
- **无 promptSnippet**：不关心系统提示词拼装
- **面向 SDK 开发者**：`AgentHarness` 用户直接用这些工具
- **实验 02 用的就是这一层**：`createReadTool()` / `createBashTool()` 从 `harness/tools/` 导入

```typescript
// 实验 02 的用法（通用层）
import { createReadTool } from "../pi/packages/agent/src/harness/tools/read.ts";
const readTool = createReadTool();  // 无 cwd 参数
// 执行时需要手动注入 context：
readTool.execute(toolCallId, params, signal, onUpdate, toolContext);
//                                                    ^^^^^^^^^^^^
```

### 2.2 产品层（coding-agent/src/core/tools）

**位置**：`packages/coding-agent/src/core/tools/`

这是 `pi-coding-agent` 在通用层基础上构建的**产品级工具**。新增了：

- **cwd 绑定**：`createReadToolDefinition(cwd, options)` —— 创建时绑定工作目录
- **promptSnippet**：注入到系统提示词"Available tools"段落的一句话描述
- **promptGuidelines**：注入到系统提示词"Guidelines"段落的指导性要点
- **ToolDefinition + AgentTool 双态**：定义态与运行时分离

```typescript
// 产品层的用法
import { createReadToolDefinition, createReadTool } from "./tools/index.ts";

const definition = createReadToolDefinition(cwd);  // → ToolDefinition（带 promptSnippet）
const tool = createReadTool(cwd);                  // → AgentTool（可执行）
```

---

## 三、核心概念：ToolDefinition vs AgentTool

这是 PI 工具系统最精妙的区分：

### 3.1 ToolDefinition（定义态）

```typescript
interface ToolDefinition<TParams, TDetails, TState> {
    name: string;                    // 工具名（LLM 调用时用）
    label: string;                   // UI 显示名
    description: string;             // 给 LLM 的描述
    promptSnippet?: string;          // ★ 注入系统提示词的一句话
    promptGuidelines?: string[];     // ★ 注入系统提示词的指导要点
    parameters: TParams;             // TypeBox 参数 schema
    executionMode?: "sequential" | "parallel";
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>;
    renderCall?(...): Component;     // Ink 自定义渲染
    renderResult?(...): Component;
}
```

**用途**：
- 构建**系统提示词**（提取 promptSnippet → "Available tools" 段落；提取 promptGuidelines → "Guidelines" 段落）
- 作为**工具注册表**的源数据
- 扩展通过 `registerTool(ToolDefinition)` 注册自定义工具

### 3.2 AgentTool（运行时态）

```typescript
type Agent = {
    name: string;
    label?: string;
    description: string;
    parameters: TSchema;
    executionMode?: ToolExecutionMode;
    execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult>;
    prepareArguments?(args): params;
};
```

**区别**：
- **无 promptSnippet / promptGuidelines** —— 这些只在构建提示词时有用
- **execute 签名少一个 `ctx` 参数** —— `Agent` 类直接调用，不需要 ExtensionContext
- 由 `wrapRegisteredTools()` 从 ToolDefinition **包装转换**而来

### 3.3 转换关系

```
ToolDefinition ───wrapRegisteredTools()───→ AgentTool
     │                                          │
     │ 用于：                                    │ 用于：
     │ - 构建系统提示词                           │ - agent.state.tools
     │ - _toolDefinitions 注册表                 │ - runLoop 执行工具调用
     │ - registerTool() 扩展注册                 │
```

---

## 四、工具加载流程（从启动到激活）

### 4.1 总览

```
用户启动 pi
    │
    ▼
createAgentSession()                    [sdk.ts:169]
    │
    ├─ defaultActiveToolNames = ["read", "bash", "edit", "write"]  [行 245]
    │
    ├─ 计算 initialActiveToolNames:
    │    options.tools → 白名单
    │    options.noTools → 空集
    │    排除 excludedToolNames
    │
    ├─ _baseToolDefinitions = createAllToolDefinitions(cwd)  ★ 所有 7 个工具的 ToolDefinition
    │
    ├─ 创建 AgentSession
    │    │
    │    ├─ _refreshToolRegistry()         [agent-session.ts:2455]
    │    │    │
    │    │    ├─ 取 _baseToolDefinitions（7 个内置 ToolDefinition）
    │    │    ├─ 取 extensionRunner.getAllRegisteredTools()（扩展注册的工具）
    │    │    ├─ 合并为 _toolDefinitions（带 sourceInfo）
    │    │    ├─ 提取 _toolPromptSnippets（构建提示词用）
    │    │    ├─ wrapRegisteredTools() → 转成 AgentTool
    │    │    └─ 存入 _toolRegistry: Map<string, AgentTool>
    │    │
    │    └─ setActiveToolsByName(initialActiveToolNames)
    │         │
    │         ├─ 从 _toolRegistry 选取激活的工具
    │         ├─ agent.state.tools = [激活的 AgentTool 列表]
    │         └─ _rebuildSystemPrompt()  ★ 用 promptSnippet 重建系统提示词
    │
    └─ 返回 session
```

### 4.2 关键代码路径

**Step 1：确定默认激活工具**（`sdk.ts:245-251`）

```typescript
const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const excludedToolNames = options.excludeTools;
const initialActiveToolNames: string[] = (
    options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
).filter((name) => !excludedToolNameSet?.has(name));
```

- `--tools read,grep` → 只启用指定的
- `--no-tools` → 全禁用
- `--exclude-tools bash` → 从默认中排除
- 默认 → `read, bash, edit, write`

**Step 2：构建工具注册表**（`agent-session.ts:2455-2521`）

```typescript
private _refreshToolRegistry(options?): void {
    // 1. 内置工具定义（过滤 allowed/excluded）
    const definitionRegistry = new Map(this._baseToolDefinitions.entries()...);

    // 2. 合并扩展和自定义工具
    const allCustomTools = [
        ...this._extensionRunner.getAllRegisteredTools(),  // 扩展注册的
        ...this._customTools.map(...),                      // SDK 传入的
    ];
    for (const tool of allCustomTools) {
        definitionRegistry.set(tool.definition.name, ...);  // 扩展可覆盖同名内置工具
    }

    // 3. 转换为运行时 AgentTool
    const wrappedBuiltInTools = wrapRegisteredTools(...);
    const wrappedExtensionTools = wrapRegisteredTools(...);

    // 4. 存入 registry（扩展工具可覆盖同名内置工具）
    const toolRegistry = new Map(wrappedBuiltInTools.map(t => [t.name, t]));
    for (const tool of wrappedExtensionTools) {
        toolRegistry.set(tool.name, tool);  // ★ 同名覆盖
    }
    this._toolRegistry = toolRegistry;
}
```

**Step 3：激活工具 + 重建提示词**（`agent-session.ts:926-941`）

```typescript
setActiveToolsByName(toolNames: string[]): void {
    const tools: AgentTool[] = [];
    for (const name of toolNames) {
        const tool = this._toolRegistry.get(name);  // 从 registry 取
        if (tool) { tools.push(tool); }
    }
    this.agent.state.tools = tools;                 // 设置到 Agent 状态

    // ★ 重建系统提示词——新工具的 promptSnippet 生效
    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
    this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
}
```

---

## 五、提示词注入：promptSnippet 与 promptGuidelines

工具不仅执行命令，还**参与构建系统提示词**。这是 PI 的独特设计。

### 5.1 promptSnippet

每个内置工具有一句话描述，注入到系统提示词的 **"Available tools"** 段落：

```
## Available tools
- read: Read a file from the local filesystem. ...
- bash: Execute a bash command and return its output. ...
- edit: Perform exact string replacements in files. ...
- write: Write content to a file, overwriting if it exists. ...
```

> 自定义工具如果不提供 `promptSnippet`，会被**从该段落省略**（但仍可通过 description 被模型调用）。

### 5.2 promptGuidelines

某些工具还会注入**使用指导**到 **"Guidelines"** 段落。例如 `edit` 工具可能有：

```
## Guidelines
- Before editing a file, read it first to understand its content.
- The old_string must be unique in the file; use replace_all for multiple.
```

### 5.3 动态生效

由于 `setActiveToolsByName` 会调用 `_rebuildSystemPrompt()`，**运行时切换工具会立即更新提示词**。这意味着：

- 扩展可以中途注册新工具并激活
- `/tools` 命令切换工具后，下一轮对话模型就能看到新的工具描述

---

## 六、扩展工具注册（registerTool）

扩展可以通过 `ExtensionAPI.registerTool()` 注册**自定义工具**，这是 PI 二次开发的核心入口之一。

### 6.1 API 签名

```typescript
registerTool<TParams extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParams, TDetails, TState>
): void;
```

### 6.2 实战示例（来自 Stage 3 的 remember 扩展）

```typescript
// ~/.pi/extensions/remember.ts
export default function ({ registerTool }: ExtensionAPI) {
    registerTool({
        name: "save_preference",
        label: "Save User Preference",
        description: "Save a user fact or preference to long-term memory.",
        promptSnippet: "save_preference: Save something the user told you to remember.",
        parameters: Type.Object({
            content: Type.String({ description: "The fact to remember" }),
            category: Type.Optional(Type.String()),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const memory = loadMemory();
            memory.push({
                id: crypto.randomUUID(),
                content: params.content,
                category: params.category ?? "general",
                createdAt: new Date().toISOString(),
                source: "auto",
            });
            saveMemory(memory);
            return {
                result: { terminate: false, content: [{ type: "text", text: "Saved." }] },
                details: { saved: true },
            };
        },
    });
}
```

### 6.3 合并规则

注册后，在下次 `_refreshToolRegistry()` 时：

- 扩展工具加入 `_toolDefinitions`
- **同名可覆盖内置工具**（`toolRegistry.set(tool.name, tool)` 是覆盖语义）
- 默认不会自动激活——需要 `includeAllExtensionTools: true` 或显式加入 active 列表
- 激活后，其 `promptSnippet` 和 `promptGuidelines` 会注入系统提示词

---

## 七、file-mutation-queue：文件写操作的串行化

**位置**：`packages/coding-agent/src/core/tools/file-mutation-queue.ts`

PI 支持工具**并行执行**（`toolExecution: "parallel"`），但文件写操作（edit/write）如果并行操作同一个文件会冲突。`withFileMutationQueue` 解决了这个问题。

### 7.1 设计

```typescript
const fileMutationQueues = new Map<string, Promise<void>>();  // 按文件路径（realpath）索引

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = await getMutationQueueKey(filePath);  // realpath 解析
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>(resolve => { releaseNext = resolve; });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    await currentQueue;       // 等前一个同文件操作完成
    try {
        return await fn();    // 执行当前操作
    } finally {
        releaseNext();        // 释放，让下一个排队操作开始
        if (fileMutationQueues.get(key) === chainedQueue) {
            fileMutationQueues.delete(key);  // 清理
        }
    }
}
```

### 7.2 语义

| 场景 | 行为 |
|------|------|
| 并行 edit **同一文件** A | 串行执行（排队） |
| 并行 edit **不同文件** A 和 B | 真并行（各有各的队列） |
| 并行 edit A + read A | read 不走队列，可能读到中间态 |

> **关键**：`key` 用 `realpath()` 解析，所以符号链接指向同一文件也会正确串行化。

---

## 八、operations 注入模式（可扩展后端）

内置工具的底层文件/Shell 操作不是硬编码的，而是通过 **operations 接口**注入。这使得 PI 工具可以适配不同后端（本地、SSH 远程、Docker 等）。

### 8.1 设计

每个工具定义一个 `XxxOperations` 接口：

```typescript
// read 工具
interface ReadOperations {
    readFile(path: string): Promise<...>;
}

// bash 工具
interface BashOperations {
    spawn(command: string, opts: ...): Promise<...>;
}

// edit/write/grep/find/ls 各有对应的 Operations 接口
```

创建工具时注入实现：

```typescript
createReadTool(cwd, {
    operations: myRemoteReadOperations,  // 自定义实现（如 SSH 远程读取）
});
```

如果不提供，使用**默认的本地实现**（`createLocalBashOperations` 等）。

### 8.2 价值

- **远程开发**：注入 SSH operations，让 pi 操作远程文件系统
- **沙箱**：注入受限 operations，限制工具能力
- **测试**：注入 mock operations，无需真实文件系统

---

## 九、工具在 Agent Loop 中的执行

工具定义和加载只是前奏，真正执行发生在 `runLoop`（`agent-loop.ts`）。以下是工具执行的完整链路：

### 9.1 执行流程

```
模型返回 message（含 toolCalls）
        │
        ▼
┌─ stopReason === "length"? ──→ 是：failToolCallsFromTruncatedMessage()（拒绝执行，防幻觉）
│       │ 否
│       ▼
│   executeToolCalls()
│       │
│       ├─ 对每个 toolCall：
│       │    1. 从 agent.state.tools 找到对应 AgentTool
│       │    2. prepareArguments（如果有，兼容性修正）
│       │    3. Schema 校验参数
│       │    4. emit("tool_execution_start")
│       │    5. tool.execute(toolCallId, params, signal, onUpdate)
│       │    6. emit("tool_execution_end")
│       │    7. 构造 ToolResultMessage
│       │
│       ├─ 并行 vs 串行：
│       │    executionMode === "sequential" → 串行
│       │    默认 → 并行（Promise.all）
│       │
│       └─ shouldTerminateToolBatch(results)
│            results.every(r => r.terminate === true) → 终止
│            （用 every 不用 some：支持并行工具，只要有一个不终止就继续）
│       │
│       ▼
│   toolResults 推入 context.messages
│   hasMoreToolCalls = !terminate
│       │
│       ▼
│   下一轮 inner loop（模型看到工具结果后继续）
```

### 9.2 终止判定

```typescript
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
    return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

- 工具返回 `terminate: true` → 表示"任务完成，不需要更多工具调用"
- **用 `every` 而非 `some`**：因为并行工具调用时，必须**全部**都终止才真正终止
- 大多数情况，终止是由**模型不再调用工具**驱动的（`toolCalls.length === 0` → `hasMoreToolCalls = false`）

---

## 十、速查表

### 10.1 关键文件索引

| 关注点 | 文件 |
|--------|------|
| 工具定义与分发中枢 | `coding-agent/src/core/tools/index.ts` |
| 工具加载到 session | `coding-agent/src/core/agent-session.ts`（`_refreshToolRegistry`、`setActiveToolsByName`） |
| session 创建入口 | `coding-agent/src/core/sdk.ts`（`createAgentSession`） |
| 通用层工具（无 cwd） | `agent/src/harness/tools/{read,bash,edit,write,image}.ts` |
| 产品层工具（带 promptSnippet） | `coding-agent/src/core/tools/{read,bash,edit,write,grep,find,ls}.ts` |
| 文件写串行化 | `coding-agent/src/core/tools/file-mutation-queue.ts` |
| 扩展工具 API | `coding-agent/src/core/extensions/types.ts`（`registerTool`、`ToolDefinition`） |
| 工具执行循环 | `agent/src/agent-loop.ts`（`executeToolCalls`、`shouldTerminateToolBatch`） |
| 截断策略 | `coding-agent/src/core/tools/truncate.ts`（`DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=30KB`） |

### 10.2 CLI 工具控制

```bash
# 指定激活工具（白名单）
pi --tools read,bash,grep,find

# 排除工具（黑名单）
pi --exclude-tools bash

# 全部禁用
pi --no-tools
```

### 10.3 自定义工具的最小模板

```typescript
import { Type } from "@sinclair/typebox";

export default function ({ registerTool }: ExtensionAPI) {
    registerTool({
        name: "my_tool",
        label: "My Tool",
        description: "Does something useful.",
        promptSnippet: "my_tool: Does something useful.",  // 注入系统提示词
        parameters: Type.Object({
            input: Type.String({ description: "Input value" }),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            // ctx 是 ExtensionContext，可访问 session、agent 等
            return {
                result: {
                    terminate: false,
                    content: [{ type: "text", text: `Processed: ${params.input}` }],
                },
            };
        },
    });
}
```

---

## 十一、设计哲学小结

1. **两层分离**：通用层（harness）与产品层（coding-agent）解耦，SDK 用户和产品用户各取所需
2. **定义态/运行时分离**：ToolDefinition 负责提示词与注册，AgentTool 负责执行，通过 `wrapRegisteredTools` 桥接
3. **工具即提示词**：工具不仅执行，还通过 promptSnippet/guidelines 参与构建系统提示词——工具的"描述"本身就是 prompt engineering 的一部分
4. **可扩展后端**：operations 注入模式让同一套工具适配本地/远程/沙箱
5. **安全并行**：file-mutation-queue 在保持并行性能的同时保证文件操作安全
6. **扩展可覆盖内置**：registerTool 同名覆盖，赋予扩展改变核心行为的能力
7. **渐进式激活**：默认只开 4 个核心工具，grep/find/ls 需显式启用——平衡能力与 token 成本
