# Stage 4：二次开发方向评估

> 基于阶段 0-3 的完整理解和 `remember` 扩展的实践
> 评估日期：2026-08-04

## 三个方向对比矩阵

| 维度 | A. 个性化编码助手 | B. 造新 Agent | C. 上游贡献 |
|---|---|---|---|
| **价值** | ★★★ 自用立刻见效 | ★★★ 学框架最深 | ★★ 长期价值 |
| **难度** | ★★ 中 | ★★★ 高 | ★★★★ 很高 |
| **工期（1人）** | 2-4 周 | 4-8 周 | 不定（看 issue） |
| **PI 扩展点利用** | Extensions + Skills + Settings | pi-agent-core SDK | 全栈 |
| **可发布性** | ✅ `pi install npm:` | 独立产品 | PR merge |
| **技术栈** | TypeScript + jiti | TypeScript + pi-agent-core + 自造 UI | PI 全栈 |
| **与已学知识复用** | 100%（5 个面全用） | 60%（不用 coding-agent 层） | 80% |
| **适合你的背景** | ✅ 编程熟+前端陌生也能做 | ⚠️ 需补 TUI/前端 | ✅ 但需熟悉贡献流程 |

---

## 方向 A：个性化编码助手（推荐 ⭐）

### 定位
把 `remember` 扩展深化成一个完整的"个性化层" package，发布到 npm 让其他 PI 用户也能用。

### 功能规划（MVP → 完整版）

**MVP（1-2 周）**——基于已有 remember.ts 扩展：
- [x] 跨会话记忆（已完成 ✅）
- [ ] 项目隔离：memory.json 按 cwd 分区
- [ ] 记忆去重：相似度检查（可用简单的字符串相似度）
- [ ] `/memory --audit`：审核 auto 提取的记忆
- [ ] 单元测试 + 文档

**完整版（再 2 周）**：
- [ ] 语义检索：记忆多时用 embedding 只注入 top-K 相关的（接 OpenAI/ZAI embedding API）
- [ ] 自动学习：监听 `message_end`，用小模型提取事实（不需用户说"记住"）
- [ ] 记忆过期：基于时间/项目阶段的 TTL
- [ ] 隐私模式：敏感字段加密
- [ ] 导入导出：从/到其他格式（如 ChatGPT custom instructions）

### 技术方案
```
my-pi-memory/
├── package.json          # pi key 声明 extensions/skills
├── extensions/
│   └── remember.ts       # 核心扩展（已有原型）
├── skills/
│   └── memory-guide.md   # 教模型何时用 save_preference
├── prompts/
│   └── remember.md       # /remember 命令模板
└── README.md
```

发布：`pi install npm:@yourname/pi-memory`

### 为什么推荐
1. **你已经验证了所有核心 API**——零新知识门槛
2. **真实有用**——自用立刻见效，解决 PI 最大痛点
3. **可发布**——PI 有完整 package 系统，npm 发布即可
4. **体量适中**——1 人 2-4 周可做出有影响力的东西
5. **与你背景契合**——TypeScript + 后端逻辑，几乎不需要前端

### 风险
- 记忆注入会增加 token 消耗（需控制记忆数量）
- 模型可能不主动调用 save_preference（需 skill 引导 + 提示工程）

---

## 方向 B：基于 pi-agent-core 造新 Agent

### 定位
跳出 coding-agent 层，用 pi-agent-core 的 `Agent`/`AgentHarness` SDK 造一个**非编码场景**的 agent（如知识助手、研究助手、文档撰写助手）。

### 技术方案
```typescript
import { Agent, AgentHarness } from "@earendil-works/pi-agent-core";
import { Models } from "@earendil-works/pi-ai";

// 自定义工具
const searchTool = defineTool({...});
const summarizeTool = defineTool({...});

// 组装 agent
const agent = new Agent({
  initialState: { systemPrompt: "你是研究助手...", model, tools: [searchTool, summarizeTool] },
  streamFn: (model, context) => Models.streamSimple(model, context),
});

// 自造 UI（这是难点！）
// 选项 1：CLI（用 Commander.js / Inquirer.js）
// 选项 2：Web（用 Next.js + SSE 流式）
// 选项 3：复用 pi-tui（但需要深入理解 TUI 库）
```

### 为什么有吸引力
- **学框架最深**——真正理解 agent 运行时的每个环节
- **自由度最高**——不受 coding-agent 的工具集限制
- **可造产品**——非编码 agent 是蓝海

### 为什么不推荐（对你而言）
1. **需要补前端栈**——你要造 UI，而你"前端栈陌生"
2. **工作量最大**——除了 agent 逻辑，还要造 UI/工具/部署
3. **与 Stage 3 成果复用低**——remember 是 coding-agent 层的扩展
4. **PI 的 pi-tui 很难复用**——它是为 coding-agent 定制的

### 何时选这个方向
- 如果你决定补前端栈，想做一个完整的 Web 产品
- 如果你对编码助手不感兴趣，想做其他领域的 agent
- 如果你想深度理解 SDK 而非产品层

---

## 方向 C：向上游贡献

### 定位
给 PI 官方仓库提 PR：修 bug、补 provider、加内置功能。

### 可能的贡献点（基于我的观察）
1. **记忆层**：把 remember 的思路做成 PI 内置的可选功能（compaction 增强）
2. **Provider 补全**：PI 支持自定义 provider，但内置的只有主流几家
3. **Skill 自动触发**：改进 progressive disclosure，让模型更可靠地加载 skill
4. **文档改进**：很多 API 没有文档（如 ExtensionContext 的完整能力）
5. **测试覆盖**：agent-loop.ts 的双队列逻辑值得更多测试

### 为什么有价值
- **长期关系**：与 PI 维护者建立联系
- **深度理解**：提 PR 需要理解代码到能改的程度
- **开源声誉**：对职业发展有益

### 为什么难度最高
1. **需熟悉贡献流程**：PI 用 biome + 自定义 CI，有严格的代码规范
2. **需对齐维护者愿景**：你的 PR 不一定符合他们的方向
3. **review 周期长**：开源项目的 PR 可能几周才有人 review
4. **需读更多源码**：贡献要求理解全局，不只是某个文件

### 何时选这个方向
- 如果你已经用 PI 一段时间，发现了明确的痛点
- 如果你有开源贡献经验
- 如果你愿意投入长期（月级别）

---

## 我的推荐路径

### 短期（接下来 1-2 周）：方向 A 的 MVP
1. 把 `remember.ts` 打磨成生产级（加项目隔离、去重、测试）
2. 打包成 PI package 结构
3. 自己用 1 周，收集真实使用反馈
4. 发布到 npm（即使只有你一个人用，也是完整的交付）

### 中期（1-3 个月）：方向 A 完整版 + 探索 B
1. 加语义检索、自动学习等进阶功能
2. 同时探索：用 pi-agent-core 造一个简单的非编码 agent（如"每日研究摘要"），验证 SDK 的通用性

### 长期（3+ 个月）：方向 C
1. 基于自用经验，向 PI 上游提改进建议
2. 最有说服力的 PR：把 remember 的核心思路做成 compaction 的增强（"跨会话 constraints 持久化"）

---

## 结论

**方向 A（个性化编码助手）是你的最优选择**，因为：
- ✅ 与你已学知识 100% 复用
- ✅ 与你背景（编程熟、前端陌生）契合
- ✅ 工期可控（2-4 周）
- ✅ 真实有用（自用 + 可发布）
- ✅ 为方向 B/C 打基础

`remember` 扩展不是一个 demo 的终点，而是方向 A 的起点。你已经证明了"跨会话记忆"可行，接下来是把它做成产品级。
