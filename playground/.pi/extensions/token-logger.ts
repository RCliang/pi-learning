/**
 * token-logger 扩展 —— Face 5 验证
 *
 * 功能：监听 message_end，把每轮 assistant 消息的 token 用量打印到 stderr。
 *
 * 这个扩展验证三件事：
 *   1. jiti 即时编译能加载 .ts 扩展（无需 build 步骤）
 *   2. on() 生命周期钩子注册机制
 *   3. ExtensionContext 提供的元数据访问（usage/model）
 *
 * 安装位置：playground/.pi/extensions/token-logger.ts（项目级）
 *   PI 启动时会扫描 .pi/extensions/*.ts 并用 jiti 编译加载
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function tokenLogger(pi: ExtensionAPI) {
	// 监听 session_start：标记扩展已加载
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("📊 token-logger 扩展已加载", "info");
	});

	// 核心逻辑：每轮 assistant 消息结束时打印 token 用量
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		// 只处理 assistant 消息（user 消息也会触发 message_end）
		if (msg.role !== "assistant") return;

		// AgentMessage 的 content 是数组；usage 在 message 上（pi-agent-core 的 AssistantMessage 结构）
		const usage = (msg as any).usage;
		if (!usage) return;

		const model = (msg as any).model ?? "unknown";
		const provider = (msg as any).provider ?? "unknown";
		const inputTokens = usage.input ?? 0;
		const outputTokens = usage.output ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
		const cost = usage.cost?.total ?? 0;

		// 写到 stderr（不污染 stdout 的 JSON 输出）
		const line =
			`[token-logger] ${provider}/${model} | ` +
			`input=${inputTokens} output=${outputTokens} cache=${cacheRead} total=${totalTokens}` +
			(cost > 0 ? ` cost=$${cost.toFixed(6)}` : "") +
			`\n`;
		process.stderr.write(line);

		// 同时在 UI 上显示一个临时状态（交互模式可见）
		ctx.ui.setStatus("token-logger", `📊 ${totalTokens} tokens`, 3000);
	});

	// 监听 tool_call：统计工具调用次数（额外验证点）
	let toolCallCount = 0;
	pi.on("tool_execution_start", async (event, ctx) => {
		toolCallCount++;
		process.stderr.write(`[token-logger] 🔧 tool #${toolCallCount}: ${event.toolName}\n`);
	});

	// 会话结束时汇总
	pi.on("session_shutdown", async (_event, ctx) => {
		process.stderr.write(`[token-logger] 会话结束，共 ${toolCallCount} 次工具调用\n`);
		ctx.ui.setStatus("token-logger", undefined);
	});
}
