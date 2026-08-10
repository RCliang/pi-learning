# Pi ThinkingLevel 机制深度解析

> 整理日期：2026-08-07
> 依据：`pi/packages/ai/src/`（pi-ai 包源码）+ `pi/packages/coding-agent/src/core/`
> 关联：`notes/pi-settings-reference.md` 第一节（模型与思考设置）

## 一、从 settings 到 API 请求的五层链路

```
settings.json: defaultThinkingLevel
  ↓ SettingsManager.getDefaultThinkingLevel()          [settings-manager.ts L746]
model-resolver: 每模型绑定 thinkingLevel               [model-resolver.ts L616]
  （未设置时回退 DEFAULT_THINKING_LEVEL = "medium"）     [defaults.ts L3]
  ↓ 作为 options.reasoning 传入 pi-ai
clampThinkingLevel(): 按模型能力收敛                    [models.ts L674-693]
  ↓ 按 provider 家族分发
三种底层控制机制之一（见第二节）
```

统一级别词汇表（`types.ts` L79-80）：

```typescript
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelThinkingLevel = "off" | ThinkingLevel;  // 共 7 档
```

### clampThinkingLevel：模型能力收敛

每个模型通过两个字段声明思考能力：

- `model.reasoning: boolean` —— 是否支持思考；不支持则只有 `"off"` 一档
- `model.thinkingLevelMap` —— 级别映射表（详见第三节）

请求级别不支持时的降级策略：**先向上找最近的支持级别，找不到再向下**（models.ts L684-691）。例如请求 `xhigh` 但模型最高只有 `high`，则用 `high`。

## 二、三种底层控制机制

不同 provider 家族把 thinkingLevel 翻译成完全不同的 API 参数：

### 机制 A：Token 预算制（Anthropic / Bedrock Claude）

`adjustMaxTokensForThinking()`（simple-options.ts L52-78）把级别翻译成硬预算：

```typescript
const defaultBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
```

- `xhigh`/`max` 被 `clampReasoning` 压到 `high`（预算制无更高档，除非走 adaptive）
- settings 的 `thinkingBudgets` 直接覆盖这张表 —— **预算制模型省 token 的精确旋钮**
- `maxTokens` 自动扩为 `base + budget`，并保底留 1024 token 给正式回答
- 最终 payload：
  - 老模型：`thinking: { type: "enabled", budget_tokens: N }`（anthropic-messages.ts L1047-1051）
  - 新 Claude（自适应思考）：`thinking: { type: "adaptive" }` + `output_config.effort`，模型自决思考量（L1033-1044）

### 机制 B：Effort 枚举制（OpenAI Responses / Completions / Codex）

不计算预算，直接把级别字符串传为 `reasoning.effort`（openai-responses.ts L312-321），经 `thinkingLevelMap` 做别名映射。`"off"` → 不传该参数。

### 机制 C：OpenAI 兼容协议变体（智谱 zai / 通义 qwen）

openai-completions.ts L743-758 的 `thinkingFormat === "zai"` 分支（GLM 协议）：

```typescript
zaiParams.thinking = options?.reasoningEffort
    ? { type: "enabled", clear_thinking: false }
    : { type: "disabled" };
// 仅当 compat.supportsReasoningEffort 时才追加：
zaiParams.reasoning_effort = mappedEffort;  // 经 thinkingLevelMap 映射后的字符串
```

**GLM-4.x 本质是开关制**：级别非 off 就发 `enabled`，low/high 无差异。qwen 系同理（`enable_thinking` 布尔）。

### Google 家族（单独处理）

- Gemini 3：`thinkingLevel` 枚举（LOW/MEDIUM/HIGH，google-generative-ai.ts L443+）
- Gemini 2.x：`budgetTokens`（0 = 关闭，-1 = 动态）

## 三、thinkingLevelMap：多档模型的接入协议

`thinkingLevelMap` 是 pi 统一 7 档与模型原生档位之间的翻译层（types.ts L81）：

```typescript
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

- 值为**字符串**：别名映射（pi 的级别 → 模型原生档位名）
- 值为 **`null`**：该级别不支持（从可用列表过滤掉）
- **键缺失**：off/minimal/low/medium/high 默认按原样支持；`xhigh`/`max` 必须有显式映射才可用（models.ts L666-671）

真实用例（generate-models.ts L430-433）：

```typescript
"claude-opus-4.8":  { minimal: "low" },         // minimal 降级为 low
"claude-sonnet-4.6": { minimal: "low", max: "max" },  // 显式开启 max 档
```

用户也可通过扩展自定义 provider 的模型定义或 `models.json` 的 `modelOverrides` 覆盖此映射（provider-composer.ts L105-107、model-config.ts L160）。

## 四、案例：GLM-5.2 的多档思考是怎么接入的

pi 在模型目录生成脚本里为 GLM-5.2 做了专门处理（generate-models.ts L240-246, L1455-1476）：

```typescript
const ZAI_GLM52_THINKING_LEVEL_MAP = {
  minimal: null,     // 不支持 → 过滤
  low: "high",       // 低档归并到 high
  medium: "high",
  high: "high",
  max: "max",        // 独占最高档
};

// 模型定义中：
reasoning: true,
thinkingLevelMap: ZAI_GLM52_THINKING_LEVEL_MAP,
compat: { thinkingFormat: "zai", supportsReasoningEffort: true },  // ← 关键开关
```

效果：GLM-5.2 原生只有 **high / max 两档**。`supportsReasoningEffort: true` 让 zai 分支额外发送 `reasoning_effort: "high"` 或 `"max"`；而 GLM-4.6 没有这个标记，思考只有开/关。

**结论**：从 glm-4.6 升级到 glm-5.2 后，`defaultThinkingLevel` 才真正产生分级效果（`/think` 循环的可用档位变为 off/high/max 映射后的档位）。

## 五、多档思考的一般实现原理（行业视角）

客户端（pi 的 thinkingLevelMap）只解决"档位翻译"，真正的多档思考在服务端有四种典型实现：

**1. Effort 枚举 + 服务端配置映射**
API 收 `reasoning_effort` 字符串，服务端映射到不同推理配置：不同的思考 token 上限、不同采样参数、甚至不同 system prompt 变体。实现成本最低，GLM-5.2、GPT-5 系列属于此类。

**2. 训练内化 effort 信号**
RL/蒸馏阶段让模型学会根据 effort 控制信号（特殊 token 或 prompt 前缀）调整思考长度与深度。同一权重适配所有档位，档位差异体现在生成长度和推理质量上，而非切换模型。这是 DeepSeek、GLM 等开源推理模型的常见路线。

**3. 预算硬约束**
API 直接接收 thinking token 预算（Claude `budget_tokens`、Gemini 2.x `budgetTokens`），模型在预算内思考，超预算强制转入回答。档位 = 预算数字，由客户端计算（即 pi 的机制 A）。

**4. 自适应思考**
不设硬档位，模型自行判断思考多少（Claude `type: "adaptive"`），effort 参数只作为倾向性偏置。最新一代模型的演进方向。

**客户端适配要点**（从 pi 的做法提炼）：
- 用统一词汇表（7 档）对外，内部按模型映射
- 不支持的档位显式置 null，由 clamp 逻辑自动就近降级
- 开关制模型（GLM-4.x）与枚举制模型（GLM-5.2）通过 compat 标志区分

## 六、实践要点

1. **glm-4.6**：`low`/`high` 无差异（开关制），省思考 token 只能 `"off"`
2. **glm-5.2**：真两档（high/max），`minimal` 被过滤，`low`/`medium` 都落到 high
3. `thinkingBudgets` 设置**仅对预算制模型（Claude）生效**
4. `hideThinkingBlock` 只影响显示，不省 token（token 在请求层已定）
5. 验证实际 payload 的方法：`complete()` 的 `onPayload` 回调打印请求体（可做第 8 个实验）

## 参考

- 核心文件：`pi/packages/ai/src/api/simple-options.ts`、`anthropic-messages.ts`、`openai-completions.ts`、`google-generative-ai.ts`
- 模型能力：`pi/packages/ai/src/models.ts`（clampThinkingLevel）
- 目录生成：`pi/packages/ai/scripts/generate-models.ts`（GLM-5.2 映射 L240-246）
