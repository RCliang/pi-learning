/**
 * 实验 02：用 Agent 类组装最小 agent，观察完整的 agent loop
 *
 * 学习目标：
 * 1. 验证 runLoop 的双层循环（steering / follow-up）
 * 2. 亲眼看到工具调用 → 工具结果 → 下一轮 的完整链路
 * 3. 理解 AgentEvent 事件序列（turn_start → message_* → tool_execution_* → turn_end）
 *
 * 运行方式（在 pi-learning 根目录）：
 *   ./pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/02-agent-loop.ts
 */

import { Agent } from "../pi/packages/agent/src/agent.ts";
import { defaultConvertToLlm } from "../pi/packages/agent/src/harness/messages.ts";
import { createReadTool } from "../pi/packages/agent/src/harness/tools/read.ts";
import { createBashTool } from "../pi/packages/agent/src/harness/tools/bash.ts";
import type { ExecutionToolContext } from "../pi/packages/agent/src/harness/tools/tool-context.ts";
import { createModels } from "../pi/packages/ai/src/models.ts";
import { zaiCodingCnProvider } from "../pi/packages/ai/src/providers/zai-coding-cn.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  // === 1. 准备模型（同实验 01）===
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  const auth = JSON.parse(readFileSync(authPath, "utf-8"));
  const zaiKey = auth["zai-coding-cn"]?.key;
  const models = createModels();
  models.setProvider(zaiCodingCnProvider());
  const model = models.getModel("zai-coding-cn", "glm-4.7")!;

  // === 2. 构造工具执行上下文 ===
  // AgentHarnessTool 的 execute 需要一个 context 参数（env: 文件系统/shell 操作）
  const toolContext: ExecutionToolContext = {
    env: {
      cwd: () => process.cwd(),
      readTextFile: async (path) => readFileSync(path, "utf-8"),
      readBinaryFile: async (path) => ({ ok: true, value: readFileSync(path) }),
      writeTextFile: async (path, content) => { throw new Error("只读实验，不允许写"); },
      // bash 工具需要的最小 shell 实现
      runShellCommand: async (command, opts) => {
        const { execSync } = await import("node:child_process");
        try {
          const output = execSync(command, {
            cwd: opts?.cwd || process.cwd(),
            encoding: "utf-8",
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout: output, stderr: "", interrupted: false };
        } catch (e: any) {
          return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, interrupted: false };
        }
      },
    } as any,
  } as any;

  // === 3. 创建工具（harness 工具需要 bindToolContext 注入 context）===
  const readTool = createReadTool();
  const bashTool = createBashTool();

  // AgentHarnessTool 的 execute 签名比 AgentTool 多一个 context 参数
  // 需要把它 currying 进去。这里用一个简单的包装。
  const adaptTool = <T extends any>(tool: any): any => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any) => {
      return tool.execute(toolCallId, params, signal, onUpdate, toolContext);
    },
  });

  // === 4. 创建 Agent ===
  const agent = new Agent({
    initialState: {
      systemPrompt: `你是一个文件分析助手。你可以用 read 工具读文件，用 bash 工具执行命令。
请简洁回答。当需要读取文件内容时，主动调用 read 工具。`,
      model,
      thinkingLevel: "low" as any,
      tools: [adaptTool(readTool), adaptTool(bashTool)],
      messages: [],
    },
    streamFn: (m, ctx, opt) => models.streamSimple(m, ctx, { ...opt, apiKey: zaiKey, reasoning: "low" }),
    convertToLlm: defaultConvertToLlm,
    toolExecution: "parallel",
  });

  // === 5. 订阅事件 —— 观察完整的 agent loop 事件序列 ===
  console.log("📡 订阅 agent 事件...\n");
  let turnCount = 0;
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        console.log("┌─ agent_start");
        break;
      case "turn_start":
        turnCount++;
        console.log(`│  ┌─ turn_start #${turnCount}`);
        break;
      case "message_start":
        if ("role" in event.message) {
          console.log(`│  │  message_start [${event.message.role}]`);
        }
        break;
      case "message_update":
        // 只显示工具调用相关的事件，文本增量太吵
        if (event.assistantMessageEvent.type === "toolcall_end") {
          console.log(`│  │  🔧 模型调用工具: ${event.assistantMessageEvent.toolCall.name}(${JSON.stringify(event.assistantMessageEvent.toolCall.arguments).slice(0, 80)})`);
        }
        break;
      case "message_end":
        if ("role" in event.message && event.message.role === "assistant") {
          const textParts = event.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text);
          if (textParts.length > 0) {
            console.log(`│  │  message_end [assistant]: ${textParts.join("").slice(0, 100)}...`);
          }
        }
        break;
      case "tool_execution_start":
        console.log(`│  │  ▶️  tool_execution_start: ${event.toolName}`);
        break;
      case "tool_execution_end":
        console.log(`│  │  ✅ tool_execution_end: ${event.toolName} (isError=${event.isError})`);
        break;
      case "turn_end":
        console.log(`│  └─ turn_end #${turnCount} (工具结果数: ${event.toolResults.length})`);
        break;
      case "agent_end":
        console.log(`└─ agent_end (总轮数: ${turnCount}, 总消息数: ${event.messages.length})`);
        break;
    }
  });

  // === 6. 发起 prompt —— 触发 agent loop ===
  console.log("\n🚀 发起任务：读取 README.md 并总结\n");
  console.log("=".repeat(60));

  await agent.prompt("读取当前目录下 pi/README.md 的前 30 行，然后用一句话总结 pi 是什么");

  console.log("=".repeat(60));
  console.log(`\n✅ Agent 完成。共 ${turnCount} 轮。`);

  // === 7. 打印最终对话历史，理解 context.messages 的结构 ===
  console.log("\n📜 最终 context.messages 结构：");
  const msgs = agent.state.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as any;
    if (!("role" in m)) continue;
    const contentSummary = Array.isArray(m.content)
      ? m.content.map((c: any) => c.type).join(",")
      : typeof m.content === "string"
        ? `string(${m.content.length} chars)`
        : "?";
    console.log(`  [${i}] role=${m.role}, content=[${contentSummary}]`);
  }

  unsubscribe();
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
