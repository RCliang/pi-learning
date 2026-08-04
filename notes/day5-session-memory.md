# Day 5 笔记：会话与记忆机制

> 验证日期：2026-08-04

## 会话文件格式（JSONL 树）

**位置**：`~/.pi/agent/sessions/--<编码后的cwd路径>--/<timestamp>_<uuid>.jsonl`

**树结构**：每行一个 JSON 对象，通过 `id`(8 字符 hex) / `parentId` 形成树。
- 支持分叉（同一 parentId 多个子节点）——这就是 `/fork`、`/branch` 的实现
- Version 3（当前）：`hookMessage` role 已重命名为 `custom`

**条目类型**：
| type | 说明 |
|---|---|
| `session` | 文件头（version, id, cwd） |
| `message` | 对话消息（AgentMessage union） |
| `model_change` | 切换模型 |
| `thinking_level_change` | 切换思考级别 |
| `compaction` | 上下文压缩摘要 |
| `branch_summary` | 分支总结 |

## 会话恢复（`-r` / `-c`）

- `pi -r`：选择并恢复某个会话
- `pi -c`：继续最近的会话
- **只恢复单棵会话树**，不聚合多个会话的信息

## Compaction —— PI 唯一像"记忆"的机制

**触发条件**（`shouldCompact`，compaction.ts:235）：
```typescript
contextTokens > contextWindow - reserveTokens  // 默认 reserveTokens=16384
```
即上下文接近窗口上限时**被动**触发。

**SUMMARIZATION_PROMPT 产出结构**：
```
## Goal
## Constraints & Preferences  ← 这是最像"学习用户"的部分
## Progress (Done / In Progress / Blocked)
## Key Decisions
## Next Steps
## Critical Context
```

**致命限制**：
1. **仅限单会话**：summary 存在 session jsonl 里，新会话不读取
2. **被动触发**：只在 context 溢出时才生成
3. **实测**：16 个会话，**0 个触发过 compaction**——日常使用很难达到

## PI 记忆能力边界

| 机制 | 跨会话? | 主动? | 备注 |
|---|---|---|---|
| AGENTS.md / context files | ✅ | ✅ 静态 | 需用户手写 |
| SYSTEM.md / APPEND_SYSTEM.md | ✅ | ✅ 静态 | 需用户手写 |
| Skills | ✅ | ✅ 静态 | 需用户手写 |
| settings.json | ✅ | ✅ 静态 | 配置项 |
| Extensions | ✅ | ✅ 代码 | 可编程 |
| Session resume (-r/-c) | ❌ | 手动 | 只恢复单棵树 |
| Compaction summary | ❌ | ❌ 被动 | 单会话内 |
| **跨会话用户画像聚合** | ❌ | ❌ | **不存在！** |

## 结论：PI 的最大空白

**PI 没有任何形式的跨会话长期记忆。** 用户每次开新会话，PI 都是"失忆"的：
- 不记得用户上次说过的偏好
- 不记得用户的项目上下文（除非写在 AGENTS.md）
- 不记得用户的技能水平、常用工具链

这是 agent harness 的刻意设计（保持极简、可预测），但也是**二次开发最有价值的土壤**。

## Stage 3 的切入点：`remember` 扩展

基于今天的理解，`remember` 扩展的技术方案已清晰：

```
用户在会话 A: /remember 我用 Python 3.12
  ↓ registerCommand("remember")
写入 ~/.pi/agent/memory.json

用户在会话 B: 我用什么 Python?
  ↓ before_agent_start 钩子触发
读取 ~/.pi/agent/memory.json
  ↓ 返回 { systemPrompt: 原prompt + <user_memory>块 }
模型看到记忆，回答 "Python 3.12"
```

**核心 API 组合**（今天全部验证过）：
- `registerCommand(name, {handler})` —— Face 5 验证
- `on("before_agent_start", h)` → `return {systemPrompt}` —— prompt-customizer.ts 示例
- `on("message_end", h)` —— token-logger.ts 验证
- `registerTool(tool)` —— hello.ts 示例（用于让模型主动提取事实）
