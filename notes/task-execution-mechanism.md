# PI 如何执行 todo list：任务推进与状态同步机制

> 问题：补上 `task-manager.ts` 后，PI 怎么执行这个 to-do list 的任务，保证清楚地知道执行到哪一步、是否完成了？
>
> 对应源码核查：`packages/coding-agent/src/core/agent-session.ts:1224`、`packages/coding-agent/src/core/extensions/types.ts:698-732`、`packages/coding-agent/examples/extensions/plan-mode/index.ts`、`packages/coding-agent/examples/extensions/plan-mode/utils.ts:161`
>
> 前置文档：`notes/pi-no-task-list.md`（PI 没有内置 todo 工具）、`notes/tool-system.md`（工具系统）、`notes/agent-loop-dual-queue.md`（双循环）

---

## 一、核心反直觉点：todo list 本身不"执行"任务

**PI 的执行机制不会因为加了 todo 而改变**——始终是 `runLoop` + `read`/`bash`/`edit` 这套工具循环。

`todo_write` 工具或 `task-manager.ts` 扩展**唯一的作用**，是维护一个**状态镜像**，让模型在每一轮都能"看见"自己走到哪了。

所以真正要回答的问题是两个：

1. **这个状态镜像怎么可靠地进入每一轮的上下文？**（让模型知道当前进度）
2. **状态又怎么被可靠地更新？**（让进度被准确记录）

PI 有**两条技术路线**，下面分别讲。

---

## 二、关键前置：钩子的真实触发时机

在讲两条路线之前，必须先澄清一个**容易踩的坑**——`before_agent_start` 到底是"启动一次"还是"每轮触发"？

这直接决定了方案设计。

### 2.1 源码证据

`packages/coding-agent/src/core/agent-session.ts:1224` 处的 emit 在 `prompt()` 调用链里：

```typescript
// Emit before_agent_start extension event
const result = await this._extensionRunner.emitBeforeAgentStart(
    expandedText,
    currentImages,
    this._baseSystemPrompt,
    this._baseSystemPromptOptions,
);
```

事件类型定义（`extensions/types.ts:698`）：

```typescript
/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    prompt: string;
    images?: ImageContent[];
    systemPrompt: string;
    systemPromptOptions: BuildSystemPromptOptions;
}
```

对比 `turn_start`（`extensions/types.ts:727`）：

```typescript
/** Fired at the start of each turn */
export interface TurnStartEvent {
    type: "turn_start";
    turnIndex: number;
    timestamp: number;
}
```

### 2.2 结论（纠正之前文档的不准确表述）

`before_agent_start` 的注释是 **"Fired after user submits prompt but before agent loop"**——关键词是 **prompt**（用户提交）和 **agent loop**（整个循环）。

**真实触发频率：**

| 边界 | 是否触发 `before_agent_start` |
|------|:---:|
| 用户每次提交一个新 prompt（按回车） | ✅ 触发一次 |
| 同一个 prompt 内的 inner loop 多轮工具调用（turn 1→2→3） | ❌ **不触发** |
| follow-up 队列驱动的下一个 agent loop | ✅ 触发（因为本质是新 prompt） |
| steering 中断注入的下一轮 | ❌ 不触发（还在同一个 agent loop 内） |

> ⚠️ 这纠正了 `notes/pi-no-task-list.md` 和我之前口头表述里"before_agent_start 每轮触发"的不准确说法。**它按 prompt 触发，不按 turn 触发。**

**含义**：单个 `prompt()` 内的多轮工具循环（比如模型连续 read→edit→bash）期间，`before_agent_start` 只在最开始触发一次。多轮之间的状态同步，只能靠**消息历史累积**或**`turn_end` 钩子**。

这个边界条件是理解 PI 执行 todo 任务的核心。

---

## 三、路线 A：工具自驱动（`todo_write` 工具）

这是 `notes/pi-no-task-list.md` 里给的方案。

### 3.1 机制

模型自己调用 `todo_write` 更新状态。状态进入下一轮的方式是**消息历史**——工具调用的入参和返回值都是 `AgentMessage`，会留在 `context.messages` 里，自然进入下一轮提示词。

### 3.2 完整执行轨迹

```
轮1: 模型调 todo_write([
        {读package.json, pending},
        {改tsconfig,     pending},
        {跑测试,          pending}
      ])
     ↓ 工具返回 "Task list: [1]⏳读package.json [2]⏳改tsconfig [3]⏳跑测试"
     ↓ 这个 ToolResultMessage 进入 context.messages

轮2: 模型在消息历史里看到上一轮的工具结果
     → 调 read(package.json)

轮3: 模型看到 read 结果
     → 调 todo_write(把"读package.json"标 completed, "改tsconfig"标 in_progress)
     → 调 edit(tsconfig.json, ...)

轮4: 模型看到 edit 结果
     → 调 bash(npm test)

轮5: 模型看到测试通过
     → 调 todo_write(全部 completed)
     → 文本回复"完成了"
     → toolCalls.length === 0, hasMoreToolCalls = false, inner loop 退出
```

### 3.3 特点

| 优点 | 缺点 |
|------|------|
| ✅ 简单——纯靠消息历史，无需额外机制 | ❌ **不可靠**——模型可能忘记更新状态 |
| ✅ 状态天然随会话持久化（在 messages 里） | ❌ 状态描述可能与实际进度脱节 |
| ✅ 实现仅需 `registerTool`，~50 行 | ❌ 依赖模型"自觉"，无强制保障 |

> 注：这是 ZCode/Claude Code 的 `TodoWrite` 也有的通病。它们靠 system prompt 里的强约束（"Always update todo status after each step"）来缓解，但本质仍是软约束。

---

## 四、路线 B：扩展强制同步（PI 官方 plan-mode 做法）

我在 `packages/coding-agent/examples/extensions/plan-mode/index.ts` 找到了 PI 自己的参考实现。它用**三个钩子配合**，比路线 A 可靠得多。

### 4.1 三个钩子的分工

| 钩子 | 触发时机 | plan-mode 在做什么 | 源码位置 |
|------|----------|---------|---------|
| `before_agent_start` | 用户提交 prompt 后、agent loop 前 | 注入 `[EXECUTING PLAN]` 消息 + 当前剩余 todo | `index.ts:201` |
| `turn_end` | **每一轮结束时** | 扫描模型回复里的 `[DONE:n]` 标记，更新 todo 状态 | `index.ts:250` |
| `agent_end` | agent loop 完全结束 | 检查是否全部完成，发"Plan Complete!" | `index.ts:262` |

### 4.2 核心源码（精简注释版）

**`before_agent_start`——读状态，注入上下文**（`index.ts:230-246`）：

```typescript
pi.on("before_agent_start", async () => {
    if (executionMode && todoItems.length > 0) {
        const remaining = todoItems.filter((t) => !t.completed);
        const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
        return {
            message: {
                customType: "plan-execution-context",
                content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
                display: false,  // ★ 不在 UI 显示，但进入 LLM 上下文
            },
        };
    }
});
```

**`turn_end`——扫描标记，写状态**（`index.ts:250-259`）：

```typescript
pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
        updateStatus(ctx);    // 更新 TUI 状态栏
    }
    persistState();           // 持久化到磁盘，支持跨会话恢复
});
```

**`agent_end`——完成检测**（`index.ts:262-277`）：

```typescript
pi.on("agent_end", async (event, ctx) => {
    if (executionMode && todoItems.length > 0) {
        if (todoItems.every((t) => t.completed)) {   // ★ 显式判定
            const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
            pi.sendMessage(
                { customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
                { triggerTurn: false },
            );
            executionMode = false;
            todoItems = [];
            updateStatus(ctx);
            persistState();
        }
        return;
    }
});
```

**`markCompletedSteps`——状态更新核心**（`utils.ts:161-168`）：

```typescript
export function markCompletedSteps(text: string, items: TodoItem[]): number {
    const doneSteps = extractDoneSteps(text);  // 正则提取 [DONE:3] 里的数字
    for (const step of doneSteps) {
        const item = items.find((t) => t.step === step);
        if (item) item.completed = true;
    }
    return doneSteps.length;
}
```

### 4.3 为什么路线 B 比路线 A 可靠

plan-mode 的精妙之处在于**让状态更新不依赖模型主动调工具**：

- 模型只需要在回复里**自然写出** `[DONE:3]` 这样的标记（比"调用 todo_write 工具并正确传参"容易得多）
- `turn_end` 钩子**强制扫描**每一轮回复，自动更新状态——模型无法"忘记"
- 状态存在扩展内部变量 + 磁盘持久化，不依赖模型记忆

这是**"约定式协议"（`[DONE:n]` 标记）+ 钩子强制执行**的组合，比"工具自驱动"的可靠性高一个量级。

---

## 五、两条路线对比

| 维度 | 路线 A（todo_write 工具） | 路线 B（plan-mode 三钩子） |
|------|--------------------------|----------------------------|
| 状态载体 | 工具入参/返回值（在消息历史里） | 扩展内部 `todoItems[]` 变量 |
| 进入上下文方式 | 靠消息历史自然累积 | `before_agent_start` 每个 prompt 注入 |
| 状态更新机制 | 模型主动调 `todo_write` | `turn_end` 扫描 `[DONE:n]` 自动更新 |
| 可靠性 | 中（模型可能忘更新） | 高（自动扫描，不依赖模型自觉） |
| 完成检测 | 模型自己判断 | `agent_end` 检查 `every(completed)` 显式判定 |
| 实现复杂度 | 低（~50 行） | 中（~200 行，但官方有完整参考） |
| 持久化 | 需自己写 | 官方带 `persistState()` |
| 跨会话恢复 | 靠 session 文件 | 靠 `persistState()` + 状态文件 |
| 单 prompt 内多轮同步 | ✅ 靠消息历史 | ⚠️ 靠消息历史 + 模型短期记忆（`before_agent_start` 不触发） |

---

## 六、四道保障：怎么保证"清楚地知道执行到哪一步、是否完成"

把两条路线的机制拆开看，PI 的答案其实是**四道保障**的组合：

### 保障 1：状态可见（每轮进入上下文）

让模型始终能看到当前进度。

- **路线 A**：工具返回值（`ToolResultMessage`）留在 `context.messages` 里，每轮自动进入提示词
- **路线 B**：`before_agent_start` 注入 `Remaining steps:` 块

### 保障 2：状态更新（进度被记录）

让每一步的完成被准确捕获。

- **路线 A**：模型主动调 `todo_write`，传入新的状态数组
- **路线 B**：`turn_end` 扫描 `[DONE:n]` 文本标记，自动更新 `todoItems[]`

### 保障 3：完成检测（知道何时收工）

让 agent 知道整个任务何时结束。

- **路线 A**：模型看到自己最后一个 todo 是 completed，自然停止调用工具（`toolCalls.length === 0` → `hasMoreToolCalls = false` → inner loop 退出）
- **路线 B**：`agent_end` 里 `todoItems.every(t => t.completed)` 显式判定，发"Plan Complete!"

### 保障 4：执行本身（真正干活）

**两条路线都一样**——还是 `read`/`bash`/`edit`/`write` 在 `runLoop` 里循环。

todo 机制完全不参与执行，它只负责"让模型保持清醒"。

---

## 七、单 prompt 内多轮状态同步的真相

这是最容易误解的地方。

### 7.1 误区

"既然 `before_agent_start` 能注入 todo 状态，那路线 B 岂不是天然每轮都能同步最新状态？"

### 7.2 真相

**不是。** 从第二节的分析，`before_agent_start` 按 prompt 触发，不按 turn 触发。

单个 `prompt()` 内的多轮工具循环（比如模型连续 `read`→`edit`→`bash`→`edit`→`bash`）期间：

```
prompt("重构这个模块")
  │
  ├─ before_agent_start 触发 ★ 注入初始 todo 状态（只这一次）
  │
  ├─ turn 1: read(foo.ts)          ← 期间 before_agent_start 不触发
  ├─ turn 2: edit(foo.ts, ...)     ← 期间 before_agent_start 不触发
  ├─ turn 3: bash(npm test)        ← 期间 before_agent_start 不触发
  ├─ turn 4: edit(bar.ts, ...)     ← 期间 before_agent_start 不触发
  └─ turn 5: 文本回复，无工具调用   ← inner loop 退出
```

**在这 5 轮里，todo 状态怎么同步？**

| 路线 | 同步方式 |
|------|----------|
| 路线 A | 每轮的工具调用/返回都在 `context.messages` 里，模型自然看到上一轮的 todo_write 结果 |
| 路线 B | `turn_end` 每轮扫描 `[DONE:n]` 更新 `todoItems[]`，但**最新的 `todoItems` 要等下一个 prompt 的 `before_agent_start` 才会重新注入**——单 prompt 内靠的是消息历史 + 模型短期记忆 |

### 7.3 跨 prompt 的完整同步链

```
prompt #1                        prompt #2（用户追问 / follow-up）
  │                                │
  ├─ before_agent_start            ├─ before_agent_start ★ 读 todoItems，注入最新状态
  │   （注入初始 todo）            │
  ├─ turn_end × N                  ├─ turn_end × N
  │   （扫描 [DONE:n]，写 todoItems）│
  ├─ agent_end                     ├─ agent_end
  │   （检查完成）                  │
  ▼                                ▼
```

**核心分工**：
- `turn_end` 负责**写状态**（跨轮累积）
- `before_agent_start` 负责**读状态注入**（跨 prompt 同步）

两者配合才能跨 `prompt()` 保持同步。**单 `prompt()` 内的多轮，状态同步靠的是消息历史 + 模型自己的短期记忆**——这也是为什么路线 B 的 `[DONE:n]` 标记很有价值：它至少把状态写进了持久化的 `todoItems`，即便单 prompt 内模型"看不见"最新状态，下一个 prompt 也能正确恢复。

---

## 八、对二次开发的启示

### 8.1 如果你要实现 task-manager

**推荐混合方案**（结合两条路线的优点）：

1. **保留 `todo_write` 工具**（路线 A）——让模型能主动规划、显式更新
2. **加 `turn_end` 钩子**（路线 B）——扫描模型回复，自动校正状态（兜底）
3. **加 `before_agent_start` 注入**（路线 B）——跨 prompt 同步最新状态
4. **加 `agent_end` 完成检测**（路线 B）——`every(completed)` 显式判定

### 8.2 官方 plan-mode 是最佳参考

`packages/coding-agent/examples/extensions/plan-mode/` 是一个**完整可运行**的实现，包含：

- `index.ts`（~400 行）——三钩子配合的主逻辑
- `utils.ts`——`extractTodoItems`、`markCompletedSteps`、`extractDoneSteps`、`isSafeCommand`
- 带磁盘持久化（`persistState`）和跨会话恢复
- 带完整的 TUI 状态栏渲染

**如果要往"个性化编码助手"方向走，直接 fork plan-mode 改造是最快的路径**，而不是从零写。

### 8.3 与学习路径的关系

这个发现进一步细化了 `notes/stage4-direction-evaluation.md` 里方向 A（个性化编码助手）的技术方案：

| 能力 | 实现路径 | 参考 |
|------|----------|------|
| 跨会话长期记忆 | `remember.ts`（`before_agent_start` 注入） | Stage 3 已完成 |
| 长程任务规划 | fork plan-mode + 持久化改造 | 本文档 |
| 两者结合 | remember 注入用户偏好，plan-mode 管任务进度 | 方向 A 的完整形态 |

---

## 九、一句话总结

> **todo list 不"执行"任务——`runLoop` + `read`/`bash`/`edit` 才是真正的执行引擎。** todo 只是一个**状态镜像**，它的全部价值在于让模型每轮都"看见"当前进度。
>
> 状态进入上下文有两条路线：**工具自驱动**（简单但不可靠，靠模型自觉）vs **扩展强制同步**（复杂但可靠，靠钩子自动扫描 `[DONE:n]` 标记）。
>
> 关键边界：`before_agent_start` **按 prompt 触发，不按 turn 触发**——单 prompt 内多轮靠消息历史，跨 prompt 靠 `before_agent_start` 重新注入。`turn_end` 写状态 + `before_agent_start` 读状态，两者配合实现完整同步。
>
> 官方 plan-mode 扩展是现成的最佳参考实现。
