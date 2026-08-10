# Stage 4 调研：pi-memory 源码级架构解读

> 分析日期：2026-08-07
> 源码：`references/pi-memory/`（克隆自 https://github.com/jayzeng/pi-memory，单文件 `index.ts` 2326 行）
> 定位：pi 生态最成熟的跨会话记忆扩展，官方包目录收录；是 Stage 3 `remember` 扩展（`playground/.pi/extensions/remember.ts`）的直接进阶参照

## 为什么研究它

Stage 3 交付 `remember` 扩展后，GitHub 调研发现 pi 生态已有 5+ 个同类项目：

| 项目 | 路线 |
|---|---|
| **jayzeng/pi-memory**（本文主角） | Markdown + qmd 搜索，功能最完整 |
| tickernelz/pi-memory | MEMORY/IDENTITY/USER 三文件分层 + 首次运行 bootstrap |
| elpapi42/pi-observational-memory | 长会话连贯性（跨 compaction/多天） |
| pi-self-learning | git-backed 经验沉淀 |
| pi-memd | 极简：每项目一个 MEMD.md |

jayzeng 版几乎覆盖了 Stage 3 笔记里列出的全部"局限与未来改进"项，因此深读其源码。

## 一、设计哲学（design.md 摘要）

三个原则：

1. **Files are the index** —— 不做独立索引/元数据库/抽取管线。记忆就是 `~/.pi/agent/memory/` 下的 markdown 文件，qmd 直接索引内容本身；`git diff` 看变更，`cat` 看存储。
2. **注入要选择性，不要穷尽** —— 旧版每轮全量注入 MEMORY.md、超限中间截断，导致早期决策被静默丢弃；新版按当前 prompt 搜索相关记忆 + 小窗口 MEMORY.md。
3. **永远优雅降级** —— 所有 qmd 依赖功能都有超时和回退；qmd 缺失时纯文件读写照常工作，没有任何功能是 critical-path。

**理论依据**：Letta（前 MemGPT）2025 年 8 月基准测试 "Is a Filesystem All You Need?"：

```
Letta (filesystem + search tools) : 74.0% (GPT-4o mini)
Mem0  (graph-based memory)        : 68.5%
```

核心洞见：LLM 本来就擅长 `grep`/`search`/文件操作（训练数据里大量出现），可以迭代改写查询、导航文件树；专用向量索引未必胜过"agent + 它已熟悉的文件系统工具"。（注：单一基准、两个系统、单一任务类型，作动机而非证明。）

**明确选择不做的**（反复杂化清单）：
- 无独立索引文件（标签/链接全在内容里，全文搜索即可命中）
- 无知识图谱（实体抽取、关系建模、查询翻译都是故障源；`[[wiki-link]]` 用内容实现交叉引用）
- 无多 collection 路由
- 注入不用语义搜索（BM25 ~30ms vs 向量 ~2s，每轮注入延迟敏感；语义模式留给模型显式调 `memory_search`）
- 无自建 chunk 边界（qmd 内部做 markdown-aware 切块）

## 二、文件布局与存储层

```
~/.pi/agent/memory/
├── MEMORY.md              # 长期记忆：决策、偏好、持久事实
├── SCRATCHPAD.md          # 待办清单（记在心里/以后要修的）
├── daily/YYYY-MM-DD.md    # 每日追加日志
└── recovery/*.json        # memory_forget 的回收站记录
```

源码要点（`index.ts`）：

- `resolveMemoryDir()`（L50-58）：跨平台 home 解析（`HOME`/`USERPROFILE`/`HOMEDRIVE+HOMEPATH`），支持 `PI_MEMORY_DIR` 环境变量覆盖
- **本地时区日期**（L90-99）：踩过坑——`toISOString()` 是 UTC，晚上（PDT 17 点后）写入会被归档到"明天"，导致注入的"今日日志"读错文件；所以手写 `localDateStr()`
- `_setBaseDir()`/`_resetBaseDir()`（L67-78）：测试可注入临时目录——**可测试性是一等公民**
- 内容约定（非强制 schema）：`#decision` `#preference` `#lesson` 等 tag + `[[wiki-link]]`，BM25 关键词搜索天然可命中，零元数据维护成本

## 三、上下文注入：优先级 + 分级截断

`buildMemoryContext()`（L711-800）按优先级组装，总预算 16K 字符：

| 优先级 | Section | 单项预算 | 截断方向 | 理由 |
|---|---|---|---|---|
| 1 | scratchpad 未完成项 | 2.0K | 头部 | 活跃工作项，必须记住 |
| 2 | 今日 daily 日志 | 3.0K | 尾部（保最新） | 当前会话的流水记录 |
| 3 | qmd 搜索结果 | 2.5K | 头部 | 对当前 prompt 的最佳猜测 |
| 4 | MEMORY.md | 4.0K | **中间**（保头尾） | 精选但可能不相关 |
| 5 | 昨日 daily 日志 | 3.0K | 尾部 | 最旧，最先被砍 |

单项合计 14.5K，与 16K 总量上限的差值留给 section 头与分隔线。截断方向有语义：日志类保尾（最新内容优先），scratchpad 保头。

注入点：`before_agent_start` 钩子，`return { systemPrompt: event.systemPrompt + ... }`（与 Stage 3 remember 相同的手法）。注入头里**除了数据还有使用指南**：教模型什么写 MEMORY.md / 什么写 daily / 用 scratchpad、鼓励 `#tag` `[[link]]`、"有人说 remember this 就立刻写"——把写入行为训练进了 prompt。

## 四、KV 缓存稳定快照（最精妙的设计）

**问题**：本地前缀缓存运行时（llama.cpp/vLLM/MLX）从第一个差异 token 开始失效。记忆块逐 turn 变化 = 每轮整个对话历史被重算。

**解法**（L1294-1330）：在刻意的 checkpoint 才刷新快照，中间轮次注入**字节级完全一致**的内容：

| 刷新时机 | 原因 |
|---|---|
| `session_start` | 每会话一个新快照 |
| `session_before_compact` | compaction 丢弃工具历史，快照必须追赶磁盘（有意的缓存边界） |
| `memory_write(long_term)` | 标记 dirty，下一轮刷新（长期写入稀少且用户期望立即生效） |
| 跨天（day rollover） | 快照日期 ≠ 今天 |

`daily`/scratchpad 高频写入**不标 dirty**——写入内容已通过工具调用参数回显给模型，模型可随时 `memory_read`/`memory_search` 拿权威最新状态。

`PI_MEMORY_SNAPSHOT=per-turn` 可切回旧行为（每轮重建 + 自动搜索注入，代价是每轮击穿缓存）。

## 五、Compaction Handoff（跨压缩记忆）

`session_before_compact`（L1485-1530）：压缩前把未完成 scratchpad 项 + 今日日志末尾 15 行写成 handoff 块追加进今日日志：

```markdown
<!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
## Session Handoff
**Open scratchpad items:**
- [ ] Fix auth bug
**Recent daily log context:**
...last 15 lines...
```

下一轮"今日日志"（优先级 2）注入时自动带上——agent 无需任何显式动作即可接续。这是比"跨会话记忆"更进一步的能力。

## 六、qmd 搜索集成与优雅降级

`searchRelevantMemories()`（L1111-1153）流程：

1. 净化 prompt：剥控制字符、限 200 字符
2. 检查 qmd 可用 + collection 存在
3. `Promise.race` 加 **3 秒超时**跑 `qmd search keyword -n 3`
4. 任何失败 `return ""`——注入只是少一个 section，永不报错、不超 3 秒

工程细节：
- **Windows shim 绕行**（L818-824）：npm cmd-shim 把字面量 `/bin/sh` 写进 qmd.cmd/qmd.ps1，在非 cygwin/git-bash 下必挂；代码直接在 PATH 里定位 qmd 的 JS 入口用 node 调
- 写入后 500ms 防抖后台 `qmd update` + 增量 `qmd embed`，fire-and-forget 不阻塞
- `detectQmd()` 带 TTL 缓存；`memory_search` 工具内发现 collection 缺失时自动补建（覆盖会话中途安装 qmd 的情况）
- 搜索三模式：keyword（BM25 ~30ms）/ semantic（向量 ~2s）/ deep（混合+rerank ~10s）

## 七、其它机制

- **删除可恢复**（L658-705）：`memory_forget` 先把匹配块写进 `recovery/<uuid>.json`（`flag:"wx"` 防覆盖），返回 recovery ID；`memory_restore` 凭 ID 恢复。`isRecoveryRecord()` 严格 schema 校验
- **退出总结**（L1375-1427, L389+）：`session_shutdown` 时用 `@mariozechner/pi-ai` 的 `complete()` 直接调 LLM 摘要本次会话，写入今日日志；监听 Ctrl+D / `/quit` 区分退出原因。只持久化真实摘要（防止"全 None."样板块污染日志再被反复注入）。`/reload` `/new` 等生命周期切换默认跳过（慢），`PI_MEMORY_SUMMARIZE_TRANSITIONS=1` 可开启
- **工具预览截断**：写类工具返回 4K 字符预览而非全文

## 八、验证体系（三层）

| 层级 | 命令 | 依赖 | 测什么 |
|---|---|---|---|
| L1 单元 | `npm test` | 仅 Bun | mock ExtensionAPI + 临时目录：优先级顺序、16K 截断、handoff、scratchpad 序列化往返、qmd 缺失降级 |
| L2 端到端 | `bun test/e2e.ts` | pi + API key | 子进程跑真实 LLM：工具注册、注入后应答、跨会话写入-召回、handoff 可见性 |
| L3 召回评测 | `bun test/eval-recall.ts` | + qmd | A/B（开/关选择性注入）：25 条记忆 × 15 问，按来源类型统计 delta，假设旧日志类问题提升最大 |

**关键测试手法**：核心逻辑全部 export 为纯函数（`buildMemoryContext`/`searchRelevantMemories`/`scratchpadAdd`...），路径用 `_setBaseDir` 注入——不启动 pi 就能测。

## 九、与 Stage 3 remember.ts 对比

| 维度 | remember.ts（Stage 3） | pi-memory |
|---|---|---|
| 存储 | `~/.pi/agent/memory.json` 结构化条目 | Markdown 文件 + `#tag`/`[[link]]` 内容约定 |
| 注入 | 全量、按 category 分组 | 优先级分级 + 16K 预算 + 分方向截断 |
| 搜索 | 无 | qmd 三级搜索（可选，核心零依赖） |
| 写入 | `save_preference` 单工具 + `/remember` | `memory_write` 双 target + 注入内使用指南 |
| 可信度区分 | ✅ `source: manual/auto`（**独有**） | 无此维度 |
| 缓存友好 | 无 | KV 稳定快照 |
| 跨压缩 | 无 | session handoff |
| 删除 | `/forget` 物理删除 | forget + recovery 回收站 |
| 自动提取 | 模型主动调工具 | 同 + 会话结束时 LLM 摘要 |
| 可测试性 | 6 项手工验证 | 2018 行单测 + e2e + 召回评测 |

## 十、对 Stage 4 方向 A（个性化编码助手）的行动项

1. **短期可抄**：优先级分级注入 + 预算截断；注入头写使用指南；`_setBaseDir` 式可测试化改造
2. **中期目标**：compaction handoff（`session_before_compact` 钩子）；删除回收站
3. **高级课题**：KV 缓存稳定快照（若面向本地模型）；qmd/全文搜索替代全量注入
4. **保留差异化**：`manual/auto` 可信度维度是 remember 独有，可演进成"auto 条目待审核"工作流（`/memory --audit`）
5. **哲学收获**：design.md 的"选择不做"清单 + Letta 基准说明——押注模型已有的文件操作能力，胜过自建检索基础设施；内容约定（tag/link）优于元数据 schema

## 参考

- 源码：`references/pi-memory/index.ts`、`references/pi-memory/design.md`
- 仓库：https://github.com/jayzeng/pi-memory（灵感来源 https://github.com/skyfallsin/pi-mem）
- Letta 基准：*Benchmarking AI Agent Memory: Is a Filesystem All You Need?*（2025-08）
