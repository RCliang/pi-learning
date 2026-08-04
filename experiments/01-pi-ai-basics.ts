/**
 * 实验 01：直接用 pi-ai 调用模型，观察事件流
 *
 * 学习目标：
 * 1. 验证 streamSimple 调用链（applyAuth → provider.streamSimple）
 * 2. 亲眼看到 AssistantMessageEvent 的各种类型
 * 3. 理解 lazyStream 的"同步返回+异步准备"
 *
 * 运行方式（在 pi 仓库根目录）：
 *   node --version  # 确认 v22.19.0
 *   ./node_modules/.bin/tsx --tsconfig tsconfig.json ../experiments/01-pi-ai-basics.ts
 */

import { createModels } from "../pi/packages/ai/src/models.ts";
import { zaiCodingCnProvider } from "../pi/packages/ai/src/providers/zai-coding-cn.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// === 1. 读取 auth.json 里的 ZAI key（模拟 PI 的认证解析）===
const authPath = join(homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const zaiKey = auth["zai-coding-cn"]?.key;
if (!zaiKey) {
  console.error("❌ 未在 ~/.pi/agent/auth.json 找到 zai-coding-cn 的 key");
  process.exit(1);
}
console.log(`✅ 读到 ZAI key（长度 ${zaiKey.length}）\n`);

// === 2. 创建 Models 实例并注册 provider ===
const models = createModels();
models.setProvider(zaiCodingCnProvider());

// === 3. 拿到模型对象 ===
const model = models.getModel("zai-coding-cn", "glm-4.7");
if (!model) {
  console.error("❌ 找不到 zai-coding-cn/glm-4.7");
  process.exit(1);
}
console.log("📦 模型信息：");
console.log(`   id: ${model.id}, provider: ${model.provider}, api: ${model.api}`);
console.log(`   baseUrl: ${model.baseUrl}`);
console.log(`   reasoning: ${model.reasoning}, contextWindow: ${model.contextWindow}`);
console.log(`   thinkingFormat: ${model.compat && "thinkingFormat" in model.compat ? model.compat.thinkingFormat : "N/A"}\n`);

// === 4. 构造 Context（注意 Context 结构对应 types.ts）===
const context = {
  systemPrompt: "你是一个简洁的助手，用一句话回答。",
  messages: [
    { role: "user" as const, content: "用一句话解释什么是 agent loop", timestamp: Date.now() },
  ],
};

// === 5. 调用 streamSimple —— 这就是 agent loop 调模型的入口 ===
console.log("🚀 调用 streamSimple...\n");

const stream = models.streamSimple(model, context, {
  apiKey: zaiKey,
  reasoning: "low",  // 低思考级别（省 token）
});

// === 6. 订阅事件流 —— 看 AssistantMessageEvent 的各种类型 ===
async function main() {
let eventCounts: Record<string, number> = {};
let fullText = "";

for await (const event of stream) {
  eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

  switch (event.type) {
    case "start":
      console.log(`⏱️  [start] 流开始`);
      break;
    case "thinking_delta":
      // 不打印思考内容（太长），只计数
      break;
    case "text_delta":
      process.stdout.write(event.delta);  // 增量打印文本
      fullText += event.delta;
      break;
    case "toolcall_end":
      console.log(`\n🔧 [toolcall_end] 模型想调用工具: ${event.toolCall.name}`);
      break;
    case "done":
      console.log(`\n\n✅ [done] stopReason=${event.reason}`);
      console.log(`   usage: input=${event.message.usage.input}, output=${event.message.usage.output} tokens`);
      break;
    case "error":
      console.log(`\n❌ [error] ${event.error.errorMessage}`);
      break;
  }
}

console.log("\n" + "=".repeat(50));
console.log("📊 事件统计：");
for (const [type, count] of Object.entries(eventCounts)) {
  console.log(`   ${type}: ${count}`);
}
console.log("\n💡 你刚亲眼看到了：");
console.log("   - streamSimple 同步返回流，背后异步做认证+加载");
console.log("   - 事件流协议（start → text_delta*N → done）");
console.log("   - 最终 AssistantMessage 带 usage 和 stopReason");
}

main().catch((e) => { console.error(e); process.exit(1); });
