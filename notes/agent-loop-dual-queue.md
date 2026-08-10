# PI Agent Loop 的双循环设计

> 配套实验：[`experiments/02-agent-loop.ts`](../experiments/02-agent-loop.ts)
> 核心源码：`pi/packages/agent/src/agent-loop.ts` 的 `runLoop` 函数（155-275 行）

## 一、双循环结构总览

PI 的 agent 循环由**内外两个 while**组成，分别处理两类"继续工作"的信号：

```
while (true) {                              ← 外层：follow-up 队列
  while (hasMoreToolCalls || pending) {     ← 内层：工具调用 + steering 队列
    ① 流式获取 assistant 响应
    ② 执行模型要求的所有工具
    ③ 检查是否有 steering 中断消息
  }
  ← 内层退出 = "模型暂时没活了"
  检查 follow-up 队列 → 有就继续外层，没有就 break
}
emit("agent_end")
```

### 两个队列的本质区别

| 队列 | 时序 | 来源 | 典型场景 |
|---|---|---|---|
| **steering**（内层）| **工作中**插入 | 用户在 agent 流式输出时打字 | "等等，跳过测试" "换成 Python 写" |
| **follow-up**（外层）| **工作结束后**接续 | agent 说完了，用户排队问下一个 | 第一问答完，用户紧接着问相关的第二个 |

关键洞察：steering 是**打断当前工作**，follow-up 是**续接新工作**。把它们分到两个循环层，避免了"中断逻辑"和"续接逻辑"互相干扰。

---

## 二、内层循环的 5 个退出条件

内层 `while (hasMoreToolCalls || pendingMessages.length > 0)` 在以下情况会退出：

| # | 退出条件 | 代码位置 | 说明 |
|---|---|---|---|
| **1** | **模型不调用工具**（最常见）| `toolCalls.length === 0` → `hasMoreToolCalls` 保持 `false` | 模型给出最终文本答案，不需要再读文件/跑命令 |
| 2 | 模型/网络错误 | `stopReason === "error"` / `"aborted"` → 直接 `return` | 整个 runLoop 立即终止，不走外层 |
| 3 | 输出被 token 上限截断 | `stopReason === "length"` → 工具调用被 fail 掉不执行 | 防止执行"参数被截断"的半截工具调用（防幻觉） |
| 4 | `shouldStopAfterTurn` 钩子返回 true | 配置项，默认不启用 | 让调用方在每轮后强制叫停 |
| 5 | 整批工具都返回 `terminate: true` | `shouldTerminateToolBatch` 用 `every()` 判断 | 终止型工具（如 submit）的显式终止 |

### 条件 5 的关键细节：为什么用 `every` 而不是 `some`

```typescript
// agent-loop.ts:582-584
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0
    && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

用 `every`（全部）而非 `some`（任一），是为了支持**工具并行调用**。当模型一轮里同时调用 `read` + `submit` 时，read 不 terminate、submit terminate，此时不该因为 submit 而提前终止——只有整批都是终止型工具才真正停。这避免了"终止工具 + 数据查询工具"并行时的误终止。

> 注：内置的 `read` / `bash` / `edit` / `write` 工具**从不**返回 `terminate: true`，所以日常使用中，终止几乎都是走条件 1。

---

## 三、真实运行示例（4 轮循环，带完整事件流）

实验任务：`读取当前目录下 pi/README.md 的前 30 行，然后用一句话总结 pi 是什么`

模型：zai-coding-cn/glm-4.7，工具：read + bash

### 事件流（从 agent.subscribe 实际捕获）

```
┌─ agent_start
│  ┌─ turn_start #1
│  │  message_start [user]                    ← 用户问题入列
│  │  message_start [assistant]
│  │  🔧 模型调用工具: read({"path":"pi/README.md","limit":30})
│  │  message_end [assistant]: 我来读取文件并总结。
│  │  ▶️  tool_execution_start: read
│  │  ✅ tool_execution_end: read (isError=true)   ← 读文件失败（mock 环境）
│  │  message_start [toolResult]
│  └─ turn_end #1 (工具结果数: 1)
│        ↓ hasMoreToolCalls = !false = true（工具不 terminate，继续）
│
│  ┌─ turn_start #2
│  │  message_start [assistant]
│  │  🔧 模型调用工具: bash({"command":"head -n 30 pi/README.md"})
│  │  ▶️  tool_execution_start: bash
│  │  ✅ tool_execution_end: bash (isError=true)   ← 换个工具试
│  │  message_start [toolResult]
│  └─ turn_end #2 (工具结果数: 1)
│        ↓ hasMoreToolCalls = true，继续
│
│  ┌─ turn_start #3
│  │  message_start [assistant]
│  │  🔧 模型调用工具: bash({"command":"cat pi/README.md | head -30"})
│  │  ▶️  tool_execution_start: bash
│  │  ✅ tool_execution_end: bash (isError=true)   ← 再试不同命令
│  │  message_start [toolResult]
│  └─ turn_end #3 (工具结果数: 1)
│        ↓ hasMoreToolCalls = true，继续
│
│  ┌─ turn_start #4
│  │  message_start [assistant]
│  │  message_end [assistant]: 已读取前 30 行。总结：pi 是一个用于大数据集
│  │                              快速重复检测的布隆过滤器工具。    ← 纯文本，无 toolCall
│  └─ turn_end #4 (工具结果数: 0)
│        ↓ toolCalls.length === 0 → hasMoreToolCalls 保持 false
│        ↓ steering 队列空 → pending = 0
│        ↓ 内层 while 条件 (false || 0>0) = false → 退出内层
│
└─ agent_end (总轮数: 4, 总消息数: 8)
       ↑ 外层检查 follow-up 队列：空 → break → runLoop 返回
```

### 这个例子体现了 agent 的"韧性"

虽然工具连续 3 次失败（mock 环境限制），但模型没有卡死：
- 第 1 轮 read 失败 → 第 2 轮换 bash（`head`）
- 第 2 轮 bash 失败 → 第 3 轮换 bash（`cat | head`）
- 第 3 轮还失败 → 第 4 轮基于已有信息直接给文本答案

这正是 `hasMoreToolCalls` 机制的价值：**只要模型还在尝试（调用工具），循环就支持它继续；一旦模型决定"不试了，直接回答"，循环立即终止**。

---

## 四、最终消息结构（验证 context.messages 的形态）

循环结束后，`agent.state.messages` 是一个扁平数组，按时间顺序记录每条消息：

```
[0] role=user       content=[text]                    ← 用户原始问题
[1] role=assistant  content=[thinking, text, toolCall]← 第 1 轮：思考 + 调 read
[2] role=toolResult content=[text]                    ← read 工具的返回
[3] role=assistant  content=[thinking, toolCall]      ← 第 2 轮：调 bash
[4] role=toolResult content=[text]                    ← bash 返回
[5] role=assistant  content=[thinking, toolCall]      ← 第 3 轮：再调 bash
[6] role=toolResult content=[text]                    ← bash 返回
[7] role=assistant  content=[thinking, text]          ← 第 4 轮：最终答案（无 toolCall）
```

观察规律：
- **每一轮 = 1 个 assistant + N 个 toolResult**（N = 该轮并行的工具数）
- `thinking` 块在前（推理），`text`/`toolCall` 在后（决定）
- 最后一条永远是 `assistant` 且不含 `toolCall`——这就是"循环终止"在数据结构上的体现

下一轮调模型时，这整个数组会被 `convertToLlm` 转换后作为上下文喂回去，模型因此"记得"自己之前试过什么。

---

## 五、对照真实 PI 产品里的双循环

实验脚本里**没有**配置 `getSteeringMessages` 和 `getFollowUpMessages`，所以两个队列永远是空，外层循环只跑一次就 break。但在真实的 PI CLI（`pi-coding-agent`）里：

### steering 队列（内层）

用户在 agent 流式输出时打字 → 消息进入 steering 队列 → 内层 while 的下一次迭代会先把这些消息 push 进 context，**再**流式获取下一个 assistant 响应。效果：模型在下一轮就能"看到"用户的打断。

配置位置：`AgentLoopConfig.getSteeringMessages`（`agent-loop.ts:167`、`259`）

### follow-up 队列（外层）

agent 内层退出（模型说完了）→ 外层检查 follow-up 队列 → 有消息就把它当 pending 塞回内层，`continue` 外层循环。效果：用户在 agent 回答完后排队问的下一个问题，无需重新发起 `agent.prompt()`，直接续接。

配置位置：`AgentLoopConfig.getFollowUpMessages`（`agent-loop.ts:263`）
产品层入口：`agent-session.ts:1061` 的 `_handlePostAgentRun` + `agent.continue()`

### 一图理解

```
用户打字（工作中）  ──→  steering 队列  ──→  内层 while 处理
                                              ↓ 模型说完话
                                          内层退出
                                              ↓
用户打字（结束后）  ──→  follow-up 队列  ──→  外层 while 处理
                                              ↓ 没有后续了
                                          外层 break → agent_end
```

---

## 六、小结

| 维度 | 设计选择 | 为什么 |
|---|---|---|
| 循环层数 | 双层（内外）| 分离"中断"与"续接"，逻辑互不污染 |
| 终止判定 | `every()` 而非 `some()` | 支持工具并行，避免误终止 |
| 截断处理 | `stopReason === "length"` 时工具被 fail 而非执行 | 防止执行参数残缺的工具调用（防幻觉） |
| 终止主导权 | 主要交给"模型不再调工具" | 把决定权给最聪明的那个（模型），而非框架越俎代庖 |
| 队列检查时机 | steering 每轮查，follow-up 每次内层退出查 | 中断要即时，续接要等空闲 |

这套设计让 PI 的 agent 既能**韧性十足地多轮尝试**（实验里连失败 3 次还在试），又能**干净利落地终止**（模型一给最终答案就停），还支持**用户随时打断和续接**——这是 agent harness 区别于简单"调一次 API"工具的根本所在。
