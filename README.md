# PI Learning — 深入理解 PI Agent 框架 + 个性化二次开发

本仓库是学习 [PI](https://github.com/earendil-works/pi)（一个极简 TypeScript agent harness）的成果集合，包含源码阅读笔记、动手验证脚本、以及一个填补 PI"跨会话记忆"空白的扩展实现。

## 📁 仓库结构

```
pi-learning/
├── experiments/                     # 动手验证脚本（可运行）
│   ├── 01-pi-ai-basics.ts          # 验证 pi-ai 层：模型流式调用
│   ├── 02-agent-loop.ts            # 验证 pi-agent-core 层：agent 循环
│   ├── 03-system-prompt.ts         # 验证 system prompt 拼装机制
│   ├── 04-skills-discovery.ts      # 验证 Skills 发现 + Progressive Disclosure
│   ├── 05-settings.ts              # 验证 Settings 合并优先级 + Trust 安全模型
│   ├── 06-session-memory.ts        # 验证会话树结构 + 记忆边界
│   └── 07-remember-test.ts         # remember 扩展的单元测试
│
├── playground/                      # PI 运行沙盒
│   ├── AGENTS.md                   # Face 1：项目规范文件样例
│   └── .pi/
│       ├── settings.json           # Face 4：项目级设置样例
│       ├── skills/
│       │   └── code-review-checklist.md   # Face 3：自定义 skill
│       └── extensions/
│           ├── token-logger.ts     # Face 5：监听 token 用量（教学样例）
│           └── remember.ts         # ⭐ Stage 3：跨会话记忆扩展
│
└── notes/                          # 学习笔记
    ├── day4-personalization-summary.md   # PI 的 5 个个性化面总结
    ├── day5-session-memory.md            # 会话/记忆机制 + 跨会话空白分析
    ├── stage3-remember-extension.md      # remember 扩展设计文档
    └── stage4-direction-evaluation.md    # A/B/C 三方向评估
```

> **注意**：PI 官方仓库（`pi/`）不纳入本仓库，需单独 clone（见下方[快速开始](#-快速开始)）。

## 🎯 学习路径

### 阶段 0-1：理解四层架构

PI 的 4 层架构：`pi-ai`（统一 LLM API）→ `pi-agent-core`（agent 运行时）→ `pi-coding-agent`（CLI 产品）→ `pi-tui`（终端 UI）。

跑 `experiments/01` 和 `02`，对照 `pi/packages/agent/src/agent-loop.ts` 的 `runLoop` 函数理解 agent 循环。

### 阶段 2：5 个个性化面

PI 的个性化机制有 5 个"面"，每个面都通过实验验证：

| 面 | 机制 | 关键认知 |
|---|---|---|
| 1. Context Files | `AGENTS.md` 注入 `<project_context>` | cwd + 祖先目录遍历 |
| 2. System Prompt 重写 | `SYSTEM.md`/`APPEND_SYSTEM.md` | 替换 vs 追加 |
| 3. Skills | `.pi/skills/*.md` → `<available_skills>` | **Progressive Disclosure**（只注入描述，按需 read） |
| 4. Settings | `.pi/settings.json` | **Trust 安全模型**（未信任目录的配置被忽略） |
| 5. Extensions | `.pi/extensions/*.ts` | jiti 即时编译，40+ 生命周期钩子 |

详见 `notes/day4-personalization-summary.md`。

### 阶段 3：remember 扩展（核心交付）

PI **没有跨会话长期记忆**——这是最大的二次开发空白。`playground/.pi/extensions/remember.ts` 填补了它：

- `/remember <事实>` 手动保存
- `/forget [id|all]` 删除
- `/memory` 查看
- `before_agent_start` 钩子自动注入到 system prompt
- `save_preference` 工具让模型主动提取用户事实

跨会话验证：会话 A 记住"用户的女朋友叫小红"，会话 B（独立 session）能正确回答。

详见 `notes/stage3-remember-extension.md`。

## 🚀 快速开始

### 前置要求

- Node.js >= 22.19.0（推荐用 nvm 管理）
- npm
- 一个 LLM provider 的 API key（如智谱 ZAI、Anthropic、OpenAI）

### 1. 克隆本仓库和 PI 源码

```bash
git clone https://github.com/RCliang/pi-learning.git
cd pi-learning

# PI 官方仓库需单独 clone（用于源码阅读和运行实验）
git clone https://github.com/earendil-works/pi.git
cd pi && npm install --ignore-scripts && cd ..
```

### 2. 配置模型 API key

以智谱 ZAI 为例：

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/auth.json << 'EOF'
{
  "zai-coding-cn": {
    "type": "api_key",
    "key": "你的智谱 API Key"
  }
}
EOF
```

其他 provider 配置见 [PI providers 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)。

### 3. 运行实验脚本

```bash
# 从源码运行 PI（无需全局安装）
# 跑实验 01：看模型流式输出
pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/01-pi-ai-basics.ts
```

### 4. 从 playground 运行 PI（测试个性化效果）

```bash
cd playground

# 信任此目录（首次运行 PI 会提示，或手动加入 trust.json）
echo '1+1' | ../pi/pi-test.sh --print --model "zai-coding-cn/glm-4.6"
```

### 5. 验证跨会话记忆

```bash
cd playground

# 清空记忆
echo '{"entries":[],"version":1}' > ~/.pi/agent/memory.json

# 会话 A：问（不知道答案）
echo '我女朋友叫什么名字？' | ../pi/pi-test.sh --print --model "zai-coding-cn/glm-4.6"

# 写入一条记忆
cat > ~/.pi/agent/memory.json << 'EOF'
{
  "entries": [
    {
      "id": "t1",
      "content": "用户的女朋友叫小红",
      "category": "fact",
      "createdAt": "2026-08-04",
      "source": "manual"
    }
  ],
  "version": 1
}
EOF

# 会话 B：同样的问题（现在能答对了！）
echo '我女朋友叫什么名字？' | ../pi/pi-test.sh --print --model "zai-coding-cn/glm-4.6"
```

## 📖 推荐阅读顺序

1. [`notes/day4-personalization-summary.md`](notes/day4-personalization-summary.md) — 建立 PI 个性化机制的全局认知
2. [`notes/day5-session-memory.md`](notes/day5-session-memory.md) — 理解为什么"跨会话记忆"是空白
3. [`playground/.pi/extensions/remember.ts`](playground/.pi/extensions/remember.ts) — 读扩展源码，看如何填补空白
4. [`notes/stage3-remember-extension.md`](notes/stage3-remember-extension.md) — 扩展的设计决策记录
5. [`notes/stage4-direction-evaluation.md`](notes/stage4-direction-evaluation.md) — 下一步方向选择

## 🔑 关键技术认知

- **Progressive Disclosure**：Skills 只注入 name+description+location 到 prompt，模型按需 `read` 文件——省 token 的精巧设计
- **Trust 安全模型**：未信任目录的 `.pi/settings.json` 被静默忽略，防止恶意项目篡改配置
- **jiti 即时编译**：扩展写 `.ts` 直接生效，无需 build 步骤——这是 PI 相比其他 agent 框架的 DX 优势
- **跨会话记忆空白**：PI 的 compaction 只在单会话内有效，新会话"失忆"——`remember` 扩展通过 `before_agent_start` 钩子 + 持久化文件填补

## 📚 参考资源

- [PI 官方仓库](https://github.com/earendil-works/pi)
- [PI 文档](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
- [Agent Skills 标准](https://agentskills.io/integrate-skills)

## 📝 License

学习用途，仅供参考。
