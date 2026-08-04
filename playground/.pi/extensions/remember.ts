/**
 * remember —— 跨会话长期记忆扩展
 *
 * 这是 Stage 3 的核心交付物。填补 PI 没有跨会话记忆的空白。
 *
 * 功能：
 *   1. /remember <事实>   —— 手动保存一条用户事实到 memory.json
 *   2. /forget [id|all]   —— 删除记忆（按 id 或全部）
 *   3. /memory            —— 查看所有已保存的记忆
 *   4. before_agent_start —— 每轮自动注入 <user_memory> 块到 system prompt
 *   5. save_preference 工具 —— 让模型主动提取并保存用户事实（进阶）
 *
 * 存储：~/.pi/agent/memory.json
 *   格式：[{ id, content, category, createdAt, source }]
 *
 * 设计原则：
 *   - 极简：单文件，无依赖，~200 行
 *   - 可预测：用户能完全控制记忆（增删查），不偷偷记录
 *   - 可移植：memory.json 是纯 JSON，可手动编辑/迁移
 *
 * 安装：复制到 ~/.pi/agent/extensions/remember.ts（全局）或 .pi/extensions/（项目级）
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ============================================================================
// 类型定义
// ============================================================================

interface MemoryEntry {
	id: string;
	content: string;
	category: "preference" | "fact" | "context" | "skill";
	createdAt: string;
	source: "manual" | "auto"; // manual=/remember，auto=save_preference 工具
}

interface MemoryStore {
	entries: MemoryEntry[];
	version: number;
}

// ============================================================================
// 持久化层
// ============================================================================

const MEMORY_PATH = join(homedir(), ".pi", "agent", "memory.json");

function loadMemory(): MemoryStore {
	try {
		if (!existsSync(MEMORY_PATH)) {
			return { entries: [], version: 1 };
		}
		const raw = readFileSync(MEMORY_PATH, "utf-8");
		const data = JSON.parse(raw);
		return {
			entries: Array.isArray(data.entries) ? data.entries : [],
			version: data.version ?? 1,
		};
	} catch {
		return { entries: [], version: 1 };
	}
}

function saveMemory(store: MemoryStore): void {
	const dir = dirname(MEMORY_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function addMemory(
	content: string,
	category: MemoryEntry["category"] = "preference",
	source: MemoryEntry["source"] = "manual",
): MemoryEntry {
	const store = loadMemory();
	const entry: MemoryEntry = {
		id: randomUUID().slice(0, 8),
		content: content.trim(),
		category,
		createdAt: new Date().toISOString(),
		source,
	};
	store.entries.push(entry);
	saveMemory(store);
	return entry;
}

function removeMemory(idOrAll: string): number {
	const store = loadMemory();
	if (idOrAll === "all") {
		const count = store.entries.length;
		store.entries = [];
		saveMemory(store);
		return count;
	}
	const before = store.entries.length;
	store.entries = store.entries.filter((e) => e.id !== idOrAll);
	saveMemory(store);
	return before - store.entries.length;
}

// ============================================================================
// System Prompt 注入
// ============================================================================

const CATEGORY_LABELS: Record<MemoryEntry["category"], string> = {
	preference: "偏好",
	fact: "事实",
	context: "上下文",
	skill: "技能",
};

function buildMemoryBlock(): string {
	const store = loadMemory();
	if (store.entries.length === 0) {
		return "";
	}

	// 按类别分组
	const byCategory = new Map<MemoryEntry["category"], MemoryEntry[]>();
	for (const e of store.entries) {
		if (!byCategory.has(e.category)) byCategory.set(e.category, []);
		byCategory.get(e.category)!.push(e);
	}

	const lines: string[] = [
		"",
		"",
		"<user_memory>",
		"Long-term facts about this user, persisted across sessions. Respect these.",
		"",
	];

	for (const [cat, entries] of byCategory) {
		lines.push(`## ${CATEGORY_LABELS[cat]}`);
		for (const e of entries) {
			lines.push(`- ${e.content}`);
		}
		lines.push("");
	}

	lines.push("</user_memory>");
	return lines.join("\n");
}

// ============================================================================
// save_preference 工具（让模型主动提取用户事实）
// ============================================================================

const savePreferenceTool = defineTool({
	name: "save_preference",
	label: "Save Preference",
	description:
		"Save a long-term fact or preference about the user that should persist across sessions. " +
		"Use this when the user states a clear preference (e.g. 'I use tabs', 'I prefer Chinese replies') " +
		"or a stable fact (e.g. 'My project uses PostgreSQL'). Do NOT use for transient task context.",
	parameters: Type.Object({
		content: Type.String({
			description: "The fact/preference to remember, phrased as a statement (e.g. 'User prefers tabs over spaces')",
		}),
		category: Type.Optional(
			Type.Union([
				Type.Literal("preference"),
				Type.Literal("fact"),
				Type.Literal("context"),
				Type.Literal("skill"),
			], { description: "Category of memory. Default: preference" }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const category = (params.category as MemoryEntry["category"]) ?? "preference";
		const entry = addMemory(params.content, category, "auto");
		return {
			content: [
				{
					type: "text" as const,
					text: `✅ Saved to long-term memory: "${entry.content}" (id: ${entry.id}, category: ${category})`,
				},
			],
			details: { id: entry.id, category },
		};
	},
});

// ============================================================================
// 扩展主入口
// ============================================================================

export default function remember(pi: ExtensionAPI) {
	// ─── 命令：/remember <事实> ───
	pi.registerCommand("remember", {
		description: "保存一条跨会话记忆（用法：/remember 我用 Python 3.12）",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("用法：/remember <要记住的事实>", "warning");
				return;
			}
			const entry = addMemory(content, "preference", "manual");
			ctx.ui.notify(`✅ 已记住 (id: ${entry.id}): ${content}`, "info");
		},
	});

	// ─── 命令：/forget [id|all] ───
	pi.registerCommand("forget", {
		description: "删除记忆（用法：/forget <id> 或 /forget all）",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("用法：/forget <id> 或 /forget all", "warning");
				return;
			}
			const removed = removeMemory(target);
			if (removed > 0) {
				ctx.ui.notify(`🗑️ 已删除 ${removed} 条记忆`, "info");
			} else {
				ctx.ui.notify(`未找到 id 为 "${target}" 的记忆`, "warning");
			}
		},
	});

	// ─── 命令：/memory ───
	pi.registerCommand("memory", {
		description: "查看所有已保存的跨会话记忆",
		handler: async (_args, ctx) => {
			const store = loadMemory();
			if (store.entries.length === 0) {
				ctx.ui.notify("📭 还没有保存任何记忆。用 /remember <事实> 来添加。", "info");
				return;
			}

			// 在 selector 里展示，方便查看
			const items = store.entries.map(
				(e) => `[${e.id}] (${CATEGORY_LABELS[e.category]}/${e.source}) ${e.content}`,
			);
			await ctx.ui.select(`已保存 ${store.entries.length} 条记忆`, items);
		},
	});

	// ─── 钩子：before_agent_start —— 注入记忆到 system prompt ───
	pi.on("before_agent_start", async (event) => {
		const memoryBlock = buildMemoryBlock();
		if (!memoryBlock) return;

		// 在原有 system prompt 末尾追加 <user_memory> 块
		return {
			systemPrompt: event.systemPrompt + memoryBlock,
		};
	});

	// ─── 工具：save_preference（让模型主动提取事实）───
	pi.registerTool(savePreferenceTool);

	// ─── 会话启动提示 ───
	pi.on("session_start", async (_event, ctx) => {
		const store = loadMemory();
		if (store.entries.length > 0) {
			ctx.ui.notify(
				`🧠 remember 已加载 ${store.entries.length} 条跨会话记忆`,
				"info",
			);
		}
	});
}
