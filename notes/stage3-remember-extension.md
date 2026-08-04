# Stage 3 交付：`remember` 跨会话记忆扩展

> 完成日期：2026-08-04
> 代码：`playground/.pi/extensions/remember.ts`（~200 行）
> 测试：6 项全部通过

## 功能清单

| 功能 | API | 验证 |
|---|---|---|
| `/remember <事实>` 手动保存 | `registerCommand` | ✅ 逻辑测试 |
| `/forget <id\|all>` 删除 | `registerCommand` | ✅ 单元测试（按 id + all） |
| `/memory` 查看全部 | `registerCommand` + `ui.select` | ✅ 代码审查 |
| 自动注入到 system prompt | `on("before_agent_start")` → `return {systemPrompt}` | ✅ **跨会话验证** |
| `save_preference` 工具（模型主动提取） | `registerTool` + `defineTool` | ✅ **模型实际调用** |
| 加载提示 | `on("session_start")` + `ui.notify` | ✅ |

## 跨会话验证（最关键）

```
会话 A（memory 空）: "我女朋友叫什么名字？" → "我没有保存..."
写入 memory.json: "用户的女朋友叫小红"
会话 B（有 memory）: "我女朋友叫什么名字？" → "你女朋友的名字叫小红" ✅
```

两个独立 session id，通过 `~/.pi/agent/memory.json` 共享状态。

## 模型主动调用工具验证

```
prompt: "请记住：我最喜欢的编程语言是 Rust"
模型行为: 主动调用 save_preference(content="用户最喜欢的编程语言是 Rust")
memory.json: 自动写入 source="auto" 的条目 ✅
```

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  remember.ts 扩展（jiti 即时编译加载）                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │ /remember   │───▶│ addMemory() → memory.json    │   │
│  │ /forget     │    │ removeMemory() → memory.json │   │
│  │ /memory     │    │ loadMemory() ← memory.json   │   │
│  └─────────────┘    └──────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ before_agent_start 钩子                         │   │
│  │   loadMemory() → buildMemoryBlock()             │   │
│  │   return { systemPrompt: 原 + <user_memory> }   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ save_preference 工具（模型可调用）              │   │
│  │   execute() → addMemory(source="auto")          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
                          ↕
              ~/.pi/agent/memory.json
              [{ id, content, category, createdAt, source }]
```

## 用到的 ExtensionAPI（全部在 Day 4/5 验证过）

| API | 来源 | 用途 |
|---|---|---|
| `registerCommand(name, {handler})` | commands.ts 示例 | 注册 /remember /forget /memory |
| `on("before_agent_start", h)` | prompt-customizer.ts | 注入 memory 到 system prompt |
| `on("session_start", h)` | token-logger.ts | 加载提示 |
| `registerTool(defineTool({...}))` | hello.ts 示例 | save_preference 工具 |
| `ctx.ui.notify/select` | event-bus.ts | 用户反馈 |
| `Type.Object/String/Union` | pi-ai TypeBox | 工具参数 schema |

## 设计决策记录

1. **为什么用 JSON 而非 SQLite/向量库？**
   - 极简：零依赖，用户可手动编辑
   - 记忆量小（通常 <100 条），JSON 足够
   - 可移植：换机器只需复制 memory.json

2. **为什么按 category 分组注入？**
   - 帮助模型理解记忆的性质（偏好 vs 事实 vs 上下文）
   - prompt 里结构化展示，模型更容易引用

3. **为什么 source 字段区分 manual/auto？**
   - manual（/remember）是用户明确要记的，高可信
   - auto（save_preference）是模型推断的，可能需要用户审核
   - 未来可加 `/memory --audit` 只看 auto 条目

4. **为什么不用 message_end 自动提取所有事实？**
   - 太激进：会记录大量噪音
   - 让模型用 save_preference 工具**主动决定**——只有明确偏好才记
   - 这是 progressive disclosure 思想的延伸：把决定权交给模型

## 局限与未来改进

- **无去重**：相同事实可能被多次记录。可加相似度检查
- **无过期**：记忆永不消失。可加 TTL 或 `/memory --prune`
- **无项目隔离**：所有项目共享 memory。可加 project 字段
- **无语义搜索**：记忆多时全量注入。可加 embedding 检索
- **无隐私控制**：memory.json 是明文。可加加密选项

这些都是 Stage 4 方向 A（个性化编码助手）可以深化的点。
