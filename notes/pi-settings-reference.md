# Pi Settings 完整配置参考

> 整理日期：2026-08-07
> 依据：`pi/packages/coding-agent/src/core/settings-manager.ts`（Settings 接口，源码权威）
> 交叉核对：`pi/packages/coding-agent/docs/settings.md`（官方文档）
> 配套实验：`experiments/05-settings.ts`（合并逻辑验证）

## 一、配置文件位置与合并规则

| 位置 | 作用域 |
|---|---|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `<cwd>/.pi/settings.json` | 项目级（当前目录） |

合并规则（`deepMergeSettings`，已在实验 05 验证）：

- **项目覆盖全局**：同名字段 project 值胜出
- **嵌套对象递归合并**：`compaction: { reserveTokens: 8192 }` 只覆盖该子字段，其余保留
- **数组整体替换**：`enabledModels`、`extensions` 等不合并
- 交互模式可用 `/settings` 命令查看/修改合并后的最终配置

## 二、项目信任（Project Trust）—— 项目配置生效的前提

项目里有 `.pi/settings.json`、`.pi` 资源或 `.agents/skills` 时，pi 首次启动会询问是否信任（决策存于 `~/.pi/agent/trust.json`）。信任后才会加载项目设置、安装项目包、执行项目扩展。

- 非交互模式（`-p` / `--mode json` / `--mode rpc`）不弹询问，回退到全局的 `defaultProjectTrust`：`ask`（默认）和 `never` 忽略项目资源，`always` 直接信任
- 单次覆盖：`--approve`/`-a` 或 `--no-approve`/`-na`
- `/trust` 命令可持久化信任决策（需重启生效）

## 三、全部设置项分类详解

### 1. 模型与思考（Model & Thinking）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `defaultProvider` | string | - | 默认 provider（如 `"anthropic"`、`"openai"`、`"zai-coding-cn"`） |
| `defaultModel` | string | - | 默认模型 ID |
| `defaultThinkingLevel` | string | - | `"off"` / `"minimal"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"` |
| `thinkingBudgets` | object | - | 每级 thinking 的自定义 token 预算（覆盖内置值） |
| `hideThinkingBlock` | boolean | `false` | 隐藏输出中的 thinking 块 |
| `showCacheMissNotices` | boolean | `false` | prompt cache 显著未命中时在 transcript 显示通知（调试缓存问题用） |

```json
{
  "thinkingBudgets": { "minimal": 1024, "low": 4096, "medium": 10240, "high": 32768 }
}
```

### 2. 上下文压缩（Compaction）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | 自动压缩开关 |
| `compaction.reserveTokens` | number | `16384` | 触发压缩前为 LLM 响应预留的 token |
| `compaction.keepRecentTokens` | number | `20000` | 压缩时保留不被总结的最近 token 量 |

> 调大 `keepRecentTokens` → 压缩后保留更多原始上下文（更保真、更耗 token）。
> 详见 `docs/compaction.md`。

### 3. 分支总结（Branch Summary）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | 分支总结时为 prompt + 响应预留的 token |
| `branchSummary.skipPrompt` | boolean | `false` | `/tree` 导航时跳过 "Summarize branch?" 询问（默认不总结） |

### 4. 重试策略（Retry）—— 双层重试

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | agent 级自动重试（瞬态错误） |
| `retry.maxRetries` | number | `3` | agent 级最大重试次数 |
| `retry.baseDelayMs` | number | `2000` | 指数退避基数（2s → 4s → 8s） |
| `retry.provider.timeoutMs` | number | SDK 默认 | provider/SDK 请求超时 |
| `retry.provider.maxRetries` | number | `0` | provider/SDK 层重试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 服务端要求的重试延迟超过此值直接报错（设 0 禁用限制） |

⚠️ 官方建议：`retry.provider.maxRetries` 保持 `0`。设大于 0 会让 SDK 层先吞掉配额耗尽错误，可能导致 agent 阻塞到配额重置。

### 5. 消息投递（Message Delivery）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `steeringMode` | string | `"one-at-a-time"` | steering（打断注入）消息发送方式：`"all"` 一次全发 / `"one-at-a-time"` 逐条 |
| `followUpMode` | string | `"one-at-a-time"` | follow-up（后续接）消息发送方式，同上 |
| `transport` | string | `"auto"` | 传输协议偏好：`"auto"` / `"sse"` / `"websocket"` / `"websocket-cached"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body 空闲超时（ms），0 禁用 |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket 握手超时（ms），0 禁用 |

### 6. 资源加载（Resources）—— extensions / skills / prompts / themes

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `packages` | array | `[]` | npm/git 包源（字符串=全量加载；对象=过滤加载） |
| `extensions` | string[] | `[]` | 本地扩展文件或目录路径 |
| `skills` | string[] | `[]` | 本地 skill 文件或目录路径 |
| `prompts` | string[] | `[]` | 本地 prompt 模板路径 |
| `themes` | string[] | `[]` | 本地主题文件路径 |
| `enableSkillCommands` | boolean | `true` | 是否把 skills 注册为 `/skill:name` 命令 |

路径解析规则：
- 全局文件里的相对路径 → 相对 `~/.pi/agent`
- 项目文件里的相对路径 → 相对 `.pi`
- 支持绝对路径、`~`、glob 模式、`!pattern` 排除、`+path` 强制包含、`-path` 强制排除

```json
{
  "packages": [
    "pi-skills",
    { "source": "@org/my-extension", "skills": ["brave-search"], "extensions": [], "autoload": false }
  ],
  "extensions": ["extensions/*.ts"],
  "skills": ["skills/", "!skills/experimental/**"]
}
```

### 7. UI 与显示（UI & Display）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `theme` | string | `"dark"` | 主题：`"dark"` / `"light"` / 自定义 |
| `uiMode` | string | `"regular"` | `"regular"` 或实验性 `"fullscreen"`（`--ui-mode` 可单次覆盖） |
| `fullscreenScrollbar` | string | `"auto"` | 全屏模式滚动条：`"auto"` / `"always"` / `"hidden"` |
| `externalEditor` | string | `$VISUAL`→`$EDITOR`→Notepad/nano | Ctrl+G 外部编辑器命令，优先于环境变量 |
| `quietStartup` | boolean | `false` | 隐藏启动 header |
| `collapseChangelog` | boolean | `false` | 更新后显示精简 changelog |
| `doubleEscapeAction` | string | `"tree"` | 编辑器为空时双击 Esc：`"tree"` / `"fork"` / `"none"` |
| `treeFilterMode` | string | `"default"` | `/tree` 默认过滤：`"default"` / `"no-tools"` / `"user-only"` / `"labeled-only"` / `"all"` |
| `editorPaddingX` | number | `0` | 输入编辑器水平内边距（0-3） |
| `outputPad` | number | `1` | 消息输出水平内边距（0/1） |
| `autocompleteMaxVisible` | number | `5` | 自动补全下拉可见条数（3-20） |
| `showHardwareCursor` | boolean | `false` | 显示终端光标（IME 定位仍保留） |

VS Code 作外部编辑器要带 `--wait`：`"externalEditor": "code --wait"`

### 8. 终端与图片（Terminal & Images）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `terminal.showImages` | boolean | `true` | 终端内显示图片（需终端支持） |
| `terminal.imageWidthCells` | number | `60` | 内联图片宽度（终端 cell 数） |
| `terminal.clearOnShrink` | boolean | `false` | 内容收缩时清空空行（可能闪烁） |
| `terminal.showTerminalProgress` | boolean | `false` | OSC 9;4 终端进度指示（源码字段，Windows Terminal 任务栏进度） |
| `images.autoResize` | boolean | `true` | 图片自动缩到 2000x2000 以内（提升模型兼容性） |
| `images.blockImages` | boolean | `false` | 完全禁止图片发送给 LLM |

### 9. Shell 与命令

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `shellPath` | string | - | 自定义 shell 路径（如 Windows 上的 Cygwin），支持 `~` |
| `shellCommandPrefix` | string | - | 每条 bash 命令的前缀（如 `"shopt -s expand_aliases"` 启用别名） |
| `npmCommand` | string[] | - | npm 操作的 argv 命令（如 `["mise", "exec", "node@20", "--", "npm"]`） |

`npmCommand` 影响所有包管理操作（安装/卸载/git 包依赖安装）。配置后 git 包依赖安装改用纯 `install` 避免 npm 专属 flag。npm 包装在 `~/.pi/agent/npm/`（用户级）或 `.pi/npm/`（项目级）。

### 10. 会话与网络

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `sessionDir` | string | - | 会话文件存储目录（绝对/相对/`~`） |
| `httpProxy` | string | - | 代理 URL，同时作为 `HTTP_PROXY`/`HTTPS_PROXY`（**仅全局有效**） |
| `enabledModels` | string[] | - | Ctrl+P 模型循环列表，支持通配符（同 `--models` CLI 格式） |

sessionDir 优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > settings.json。

```json
{ "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"], "httpProxy": "http://127.0.0.1:7890" }
```

### 11. 信任、隐私与遥测

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `defaultProjectTrust` | string | `"ask"` | 项目信任回退行为：`"ask"` / `"always"` / `"never"`（**仅全局有效**） |
| `enableInstallTelemetry` | boolean | `true` | 安装/更新后的匿名版本 ping（不控制更新检查本身） |
| `enableAnalytics` | boolean | `false` | 选择性分析数据共享 |
| `trackingId` | string | - | 分析追踪 ID（启用 analytics 时生成） |
| `warnings.anthropicExtraUsage` | boolean | `true` | Anthropic 订阅认证可能产生付费额外用量时的警告 |

关闭所有启动网络活动：`--offline` 或 `PI_OFFLINE=1`；仅跳过版本检查：`PI_SKIP_VERSION_CHECK=1`。

### 12. 其它

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `markdown.codeBlockIndent` | string | `"  "` | 代码块缩进 |
| `lastChangelogVersion` | string | - | 内部字段：记录已读 changelog 版本（勿手动改） |

## 四、完整示例

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "retry": { "enabled": true, "maxRetries": 3 },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": { "anthropicExtraUsage": true },
  "packages": ["pi-skills"]
}
```

## 五、实用配方（Recipes）

**国内代理 + 智谱模型**（对应 playground 实践）：
```json
{
  "defaultProvider": "zai-coding-cn",
  "defaultModel": "glm-4.6",
  "httpProxy": "http://127.0.0.1:7890"
}
```

**加载本地 remember 扩展**：
```json
{ "extensions": ["extensions/remember.ts"] }
```

**长上下文保真**（压缩少丢细节）：
```json
{ "compaction": { "keepRecentTokens": 40000 } }
```

**禁用所有图片（纯文本场景省 token）**：
```json
{ "images": { "blockImages": true } }
```

## 六、注意事项

1. `defaultProjectTrust` 和 `httpProxy` 是**仅全局生效**的设置，写在项目 settings.json 里无效
2. 项目设置生效前必须通过信任流程（见第二节）
3. 数组类设置（`enabledModels`/`extensions` 等）项目级会**整体替换**全局值，不是追加
4. 修改 `uiMode` 需重启生效
5. settings.json 写入有 lockfile 保护（`proper-lockfile`），多进程并发安全

## 参考

- 源码：`pi/packages/coding-agent/src/core/settings-manager.ts`（Settings 接口 L86-134）
- 官方文档：`pi/packages/coding-agent/docs/settings.md`
- 相关文档：`docs/compaction.md`、`docs/packages.md`、`docs/environment-variables.md`
