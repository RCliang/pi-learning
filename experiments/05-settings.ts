/**
 * 实验 05：验证 Face 4 — Settings (settings.json)
 *
 * 目标：理解并验证 PI 的设置系统
 *   1. 全局 vs 项目设置的合并优先级（project 覆盖 global）
 *   2. 关键字段如何影响 agent 行为
 *   3. settings.json 加载与锁机制
 *
 * 关键源码：packages/coding-agent/src/core/settings-manager.ts
 *   - FileSettingsStorage: global=settings.json, project=.pi/settings.json
 *   - deepMergeSettings: project 字段覆盖 global，嵌套对象递归合并
 *
 * 运行方式：
 *   pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/05-settings.ts
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

// 不直接 import SettingsManager（依赖 lockfile、config），而是验证其核心合并逻辑
// 复刻 deepMergeSettings 验证它的行为
function deepMergeSettings<T extends Record<string, unknown>>(base: T, overrides: T): T {
  const result: T = { ...base };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const overrideValue = overrides[key];
    const baseValue = base[key];
    if (overrideValue === undefined) continue;
    if (
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      (result as Record<string, unknown>)[key] = { ...(baseValue as object), ...(overrideValue as object) };
    } else {
      (result as Record<string, unknown>)[key] = overrideValue;
    }
  }
  return result;
}

async function main() {
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const playgroundDir = resolve(projectRoot, "playground");
  const piRoot = resolve(projectRoot, "pi");

  console.log("═".repeat(72));
  console.log("Face 4 — Settings (settings.json) 验证");
  console.log("═".repeat(72));

  // === 1. 全局 vs 项目路径 ===
  console.log("\n📋 设置文件路径：");
  console.log(`   全局 (user):   ~/.pi/agent/settings.json`);
  console.log(`   项目 (project): <cwd>/.pi/settings.json`);
  console.log(`   合并规则:       project 覆盖 global，嵌套对象递归合并`);

  // 看看真实存在的全局设置
  const globalSettingsPath = resolve(process.env.HOME || process.env.USERPROFILE || "", ".pi/agent/settings.json");
  console.log(`\n   全局设置文件: ${globalSettingsPath}`);
  console.log(`   存在? ${existsSync(globalSettingsPath) ? "✅" : "❌（未创建）"}`);
  if (existsSync(globalSettingsPath)) {
    const content = readFileSync(globalSettingsPath, "utf-8");
    console.log(`   内容（前 500 字符）:\n${content.slice(0, 500)}`);
  }

  // === 2. 合并优先级验证 ===
  console.log("\n" + "═".repeat(72));
  console.log("🧪 测试 1：合并优先级（project 覆盖 global）");
  console.log("═".repeat(72));

  const globalSettings = {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4",
    defaultThinkingLevel: "medium",
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    enabledModels: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
  };

  const projectSettings = {
    defaultProvider: "zai-coding-cn",     // 覆盖
    defaultThinkingLevel: "high",         // 覆盖
    compaction: { reserveTokens: 8192 },  // 部分覆盖嵌套字段
    enabledModels: ["zai-coding-cn/glm-4.6"],  // 数组整体替换（不合并）
  };

  const merged = deepMergeSettings(globalSettings as any, projectSettings as any) as typeof globalSettings;

  console.log("\n   Global:                          Project override:");
  console.log(`   defaultProvider: anthropic   →    zai-coding-cn       结果: ${merged.defaultProvider}  ${merged.defaultProvider === "zai-coding-cn" ? "✅" : "❌"}`);
  console.log(`   defaultModel: claude-sonnet-4 (未覆盖)                    结果: ${merged.defaultModel}  ${merged.defaultModel === "claude-sonnet-4" ? "✅" : "❌"}`);
  console.log(`   defaultThinkingLevel: medium →    high                 结果: ${merged.defaultThinkingLevel}  ${merged.defaultThinkingLevel === "high" ? "✅" : "❌"}`);
  console.log(`   compaction.enabled: true     (未覆盖)                    结果: ${merged.compaction.enabled}  ${merged.compaction.enabled === true ? "✅" : "❌"}`);
  console.log(`   compaction.reserveTokens: 16384 → 8192                  结果: ${merged.compaction.reserveTokens}  ${merged.compaction.reserveTokens === 8192 ? "✅" : "❌"}`);
  console.log(`   compaction.keepRecentTokens: 20000 (未覆盖)              结果: ${merged.compaction.keepRecentTokens}  ${merged.compaction.keepRecentTokens === 20000 ? "✅" : "❌"}`);
  console.log(`   enabledModels: [2 项]        → [1 项]（数组整体替换）     结果: ${JSON.stringify(merged.enabledModels)}  ${merged.enabledModels.length === 1 ? "✅" : "❌"}`);

  // === 3. 字段分类索引 ===
  console.log("\n" + "═".repeat(72));
  console.log("📚 关键字段分类（来自 Settings 接口）");
  console.log("═".repeat(72));

  const categories = [
    {
      name: "模型与思考",
      fields: [
        ["defaultProvider", "默认 provider (如 'zai-coding-cn')"],
        ["defaultModel", "默认模型 id"],
        ["defaultThinkingLevel", "minimal/low/medium/high"],
        ["enabledModels", "模型循环列表（/model 切换）"],
        ["thinkingBudgets", "每级 thinking 的 token 预算"],
      ],
    },
    {
      name: "Agent 行为",
      fields: [
        ["compaction", "上下文压缩：enabled/reserveTokens/keepRecentTokens"],
        ["branchSummary", "分支总结提示"],
        ["retry", "重试策略"],
        ["steeringMode", "all / one-at-a-time（中断注入模式）"],
        ["followUpMode", "all / one-at-a-time（后续接模式）"],
      ],
    },
    {
      name: "工具与扩展",
      fields: [
        ["packages", "npm/git 包源（extensions/skills/prompts/themes）"],
        ["extensions", "本地扩展文件路径数组"],
        ["skills", "本地 skill 路径数组"],
        ["prompts", "本地 prompt 模板路径"],
        ["enableSkillCommands", "是否注册 /skill:name 命令（默认 true）"],
      ],
    },
    {
      name: "网络与终端",
      fields: [
        ["transport", "auto/sse/websocket/http"],
        ["httpProxy", "HTTP/HTTPS 代理"],
        ["httpIdleTimeoutMs", "HTTP idle 超时（0=禁用）"],
        ["shellPath", "自定义 shell（Cygwin 用户）"],
        ["shellCommandPrefix", "每条 bash 命令前缀"],
      ],
    },
  ];

  for (const cat of categories) {
    console.log(`\n  【${cat.name}】`);
    for (const [field, desc] of cat.fields) {
      console.log(`    • ${field.padEnd(24)} ${desc}`);
    }
  }

  // === 4. 实际写入项目设置并验证加载 ===
  console.log("\n" + "═".repeat(72));
  console.log("🧪 测试 2：写一个项目级 settings.json，验证文件被读取");
  console.log("═".repeat(72));

  const projectSettingsPath = resolve(playgroundDir, ".pi/settings.json");
  const testSettings = {
    defaultThinkingLevel: "low",  // 改成 low，便于观察
    compaction: { enabled: true, keepRecentTokens: 10000 },
    enableSkillCommands: true,
  };

  console.log(`\n   写入: ${projectSettingsPath}`);
  writeFileSync(projectSettingsPath, JSON.stringify(testSettings, null, 2), "utf-8");
  console.log(`   内容: ${JSON.stringify(testSettings, null, 2)}`);

  // 读回验证
  const readBack = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
  console.log(`\n   读回验证:`);
  console.log(`     defaultThinkingLevel === 'low'?  ${readBack.defaultThinkingLevel === "low" ? "✅" : "❌"}`);
  console.log(`     compaction.keepRecentTokens === 10000?  ${readBack.compaction?.keepRecentTokens === 10000 ? "✅" : "❌"}`);

  console.log("\n💡 后续可在 PI 交互模式用 /settings 命令查看合并后的最终配置");
  console.log("   现在保留 settings.json 用于后续 Face 5 测试");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
