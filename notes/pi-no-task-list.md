# PI 长程任务能力分析：没有内置任务清单

> 问题：PI agent 如果想执行一个较难的长程任务，会自己设定 task list 吗？
>
> 结论：**不会。** PI 没有任何 todo/task 工具，也没有提示词层面的规划引导。
>
> 对应源码核查：`packages/coding-agent/src/core/tools/index.ts`、`packages/coding-agent/src/core/system-prompt.ts`

---

## 一、结论（先说答案）

PI **没有** `TodoWrite` / `task_list` / `plan` 之类的内置工具，默认系统提示词里也**没有**任何"先分解任务""维护任务清单""mark as in_progress/completed"的引导。

面对长程任务，PI 的 agent 全靠**模型自身能力**裸跑。

---

## 二、源码证据

### 2.1 内置工具里没有 todo/task 工具

`packages/coding-agent/src/core/tools/index.ts` 全部内置工具只有 7 个，全是文件/命令操作：

```typescript
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
```

在整个 `packages/coding-agent/src/core/tools/` 目录下搜索 `todo`、`checklist`、`tasklist`、`task_list`——**零命中**。

### 2.2 默认系统提示词里没有规划引导

`packages/coding-agent/src/core/system-prompt.ts`（162 行，完整通读）拼装的提示词结构：

```
You are an expert coding assistant operating inside pi...

Available tools:
- read: ...
- bash: ...
- edit: ...
- write: ...

In addition to the tools above, you may have access to other custom tools...

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- (有 grep/find/ls 时) Use bash for file operations like ls, rg, find

Pi documentation (read only when the user asks about pi itself...):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath}
- ...

<project_context>
  <project_instructions path="...">...</project_instructions>
</project_context>

<skills> (formatSkillsForPrompt)

Current working directory: ${promptCwd}
```

搜索 `plan`、`break down`、`step by step`、`complex task`、`long task`、`multi step`——**全部零命中**。

提示词里对 agent 行为的约束只有两条 `Guidelines`：
- "Be concise in your responses"
- "Show file paths clearly when working with files"

**没有任何任务规划/进度跟踪的引导。**

---

## 三、这意味着什么

| 维度 | PI 的表现 |
|------|-----------|
| ✅ **多轮工具调用** | 完全支持。`runLoop` 的工具循环让模型可以 read/bash/grep/find 一步步探索、推进 |
| ✅ **上下文保留** | session + compaction 在单会话内有效（见 `notes/day5-session-memory.md`） |
| ❌ **任务分解** | 无显式机制——靠模型自己在文本回复里"想" |
| ❌ **进度跟踪** | 无 in_progress/pending/completed 状态机 |
| ❌ **跨会话记忆** | 无（这是更大的空白，见 `notes/stage3-remember-extension.md`） |

### 3.1 与重量级 agent 的对比

**ZCode / Claude Code 等"产品级" agent 都有 `TodoWrite` 工具**（结构化的任务状态机）：

```
TodoWrite([
    { content: "读取入口文件", status: "completed" },
    { content: "定位 bug", status: "in_progress" },
    { content: "写测试", status: "pending" },
])
```

模型可以主动调用它把任务结构化，工具结果会渲染成可视化的清单，状态变更也会被追踪。

**PI 刻意没有这个**。这是它作为"极简 harness"的取舍——`pi-agent-core` 只提供工具循环机制（`runLoop`），不规定 agent 该怎么"思考"。

### 3.2 PI 把任务管理交给了谁

| 替代方案 | 谁来做 |
|----------|--------|
| 任务分解 | 模型自己在文本回复里"想"（无工具支撑） |
| 进度跟踪 | 用户看着 transcript，或靠 session compaction 保留上下文 |
| 显式计划 | 用户自己写 skill / 改 `APPEND_SYSTEM.md` 注入规划引导 |

---

## 四、这是个真实的二次开发机会

补齐这个能力非常简单——一个 `task-manager.ts` 扩展就够了。这是 PI 扩展系统（`registerTool` + `promptGuidelines`）的经典应用：

```typescript
// .pi/extensions/task-manager.ts（示意）
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../extensions/types.ts";

interface Todo {
    content: string;
    status: "pending" | "in_progress" | "completed";
}

export default function ({ registerTool }: ExtensionAPI) {
    let todos: Todo[] = [];  // 也可持久化到 ~/.pi/agent/tasks.json

    registerTool({
        name: "todo_write",
        label: "Task List",
        description: "Create or update a structured task list for complex multi-step work.",
        promptSnippet: "todo_write: Plan and track multi-step tasks with status tracking.",
        promptGuidelines: [
            "For non-trivial tasks, FIRST call todo_write to break the work into concrete steps.",
            "Mark a task 'in_progress' before starting it, 'completed' immediately when done.",
            "Keep at most one task in_progress at a time.",
        ],
        parameters: Type.Object({
            todos: Type.Array(Type.Object({
                content: Type.String({ description: "What needs to be done" }),
                status: Type.Union([
                    Type.Literal("pending"),
                    Type.Literal("in_progress"),
                    Type.Literal("completed"),
                ]),
            })),
        }),
        async execute(toolCallId, params) {
            todos = params.todos;
            const summary = todos.map((t, i) =>
                `[${i + 1}] ${t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳"} ${t.content}`
            ).join("\n");
            return {
                result: {
                    terminate: false,
                    content: [{ type: "text", text: `Current task list:\n${summary}` }],
                },
                details: { todoCount: todos.length },
            };
        },
    });
}
```

### 4.1 为什么这个扩展有效

关键在 `promptGuidelines`：

- 注册后，PI 在下次 `_refreshToolRegistry()` 时把这三条 guideline 注入系统提示词的 **Guidelines** 段落（见 `notes/tool-system.md` 第五节）
- `setActiveToolsByName` 会触发 `_rebuildSystemPrompt()`——**提示词立即生效**
- 模型在下一轮对话就能看到"先分解任务"的引导，大概率会主动调用 `todo_write`

### 4.2 价值定位

这一个扩展就能把 PI 从**"工具循环器"**升级成**"有规划能力的 agent"**：

- **小**：~50 行 TypeScript，纯前端，无需改 PI 源码
- **准**：直接命中 PI 最大的能力空白（结构化任务管理）
- **实**：自用立刻见效（长程重构、多文件改动时进度可视化）

---

## 五、与现有学习路径的关系

这个发现进一步验证了 Stage 3（remember 扩展）选的方向——**PI 的二次开发土壤就在扩展层**：

| 空白点 | 补齐方式 | 已做？ |
|--------|----------|:------:|
| 跨会话长期记忆 | `remember.ts` 扩展（`before_agent_start` 注入 + `save_preference` 工具） | ✅ Stage 3 |
| 长程任务规划 | `task-manager.ts` 扩展（`todo_write` 工具 + `promptGuidelines`） | ❌ 候选方向 |

两者都属于"用 `registerTool` + 提示词注入补齐 agent 元认知能力"的同一类工作，技术栈完全一致。如果选定**方向 A（个性化编码助手）**，`task-manager` 是比 `remember` 更高频、更可见的能力。

---

## 六、一句话总结

> **PI 刻意保持极简，不给 agent 内置任务清单能力。** 长程任务全靠模型裸跑 + session compaction 保留上下文。
>
> 这是个真实的空白点，也是二次开发最容易出价值的方向之一——一个 `todo` 扩展 ≈ 把 PI 从"工具循环器"升级成"有规划能力的 agent"，且实现仅需 `registerTool` + `promptGuidelines`，~50 行代码。
