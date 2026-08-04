/**
 * 实验 06：Day 5 — 会话与"记忆"机制
 *
 * 目标：理解 PI 的会话系统，确认"没有跨会话长期记忆"这个判断
 *
 * 验证内容：
 *   1. 会话文件的 JSONL 树结构（id/parentId 链）
 *   2. 会话恢复（-r/-c）只恢复单棵会话树，不聚合用户画像
 *   3. compaction 的 "Constraints & Preferences" 段落是唯一像"学习"的机制，但仅限单会话
 *   4. 对比：PI 的"记忆"边界在哪里
 *
 * 运行方式：
 *   pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/06-session-memory.ts
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";

interface SessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: any;
	[key: string]: any;
}

async function main() {
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const sessionsDir = resolve(homedir(), ".pi/agent/sessions");

  console.log("═".repeat(72));
  console.log("Day 5 — 会话与记忆机制验证");
  console.log("═".repeat(72));

  // === 1. 找到 playground 的会话目录 ===
  // 路径编码：E:\2026projects\pi-learning\playground → --E--2026projects-pi-learning-playground--
  const playgroundSessionDir = resolve(sessionsDir, "--E--2026projects-pi-learning-playground--");
  console.log(`\n📁 会话目录: ${playgroundSessionDir}`);
  console.log(`   存在? ${existsSync(playgroundSessionDir) ? "✅" : "❌"}`);

  if (!existsSync(playgroundSessionDir)) {
    console.log("（没有会话文件，跳过）");
    return;
  }

  const sessionFiles = readdirSync(playgroundSessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // 最新的在前

  console.log(`   会话文件数: ${sessionFiles.length}`);

  // === 2. 解析最新的会话文件 ===
  const latestFile = sessionFiles[0];
  const latestPath = resolve(playgroundSessionDir, latestFile);
  console.log(`\n📋 最新会话: ${latestFile}`);

  const lines = readFileSync(latestPath, "utf-8").split("\n").filter(Boolean);
  const entries: SessionEntry[] = lines.map((l) => {
    try { return JSON.parse(l); } catch { return { type: "parse_error" }; }
  });

  console.log(`   总条目数: ${entries.length}`);

  // === 3. 统计条目类型 ===
  const typeCounts: Record<string, number> = {};
  for (const e of entries) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  console.log(`\n   条目类型统计:`);
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${type.padEnd(28)} ${count}`);
  }

  // === 4. 验证树结构（id/parentId 链） ===
  console.log("\n" + "═".repeat(72));
  console.log("🌳 会话树结构（id/parentId 链）");
  console.log("═".repeat(72));

  const header = entries[0];
  console.log(`\n   Session header:`);
  console.log(`     version: ${header.version}`);
  console.log(`     id:      ${header.id}`);
  console.log(`     cwd:     ${header.cwd}`);

  // 构建树
  const byId = new Map<string, SessionEntry>();
  const childrenOf = new Map<string | null, SessionEntry[]>();
  for (const e of entries) {
    if (!e.id) continue;
    byId.set(e.id, e);
    const pid = e.parentId ?? null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(e);
  }

  // 找根节点的子节点（parentId === null 或指向 header）
  const roots = childrenOf.get(null) ?? [];
  console.log(`\n   根条目数 (parentId=null): ${roots.length}`);

  // 检查是否有分叉（一个 parentId 有多个子节点）
  let branchPoints = 0;
  for (const [pid, kids] of childrenOf) {
    if (kids.length > 1) branchPoints++;
  }
  console.log(`   分叉点数 (同一 parent 有多个子): ${branchPoints}`);

  // 打印前 10 条链
  console.log(`\n   前 10 条条目链:`);
  for (const e of entries.slice(0, 10)) {
    const id = e.id ?? "?";
    const pid = e.parentId ?? "null";
    let desc = "";
    if (e.type === "message" && e.message) {
      const role = e.message.role;
      if (role === "user") {
        const text = typeof e.message.content === "string"
          ? e.message.content
          : JSON.stringify(e.message.content)?.slice(0, 50);
        desc = `user: "${text?.slice(0, 60)}"`;
      } else if (role === "assistant") {
        desc = `assistant (${e.message.provider}/${e.message.model}, ${e.message.usage?.totalTokens ?? "?"} tokens)`;
      } else {
        desc = `${role}`;
      }
    } else if (e.type === "compaction") {
      desc = `compaction (tokensBefore=${e.tokensBefore})`;
    } else if (e.type === "model_change") {
      desc = `→ ${e.provider}/${e.modelId}`;
    } else if (e.type === "thinking_level_change") {
      desc = `thinking=${e.thinkingLevel}`;
    } else {
      desc = e.type;
    }
    console.log(`     ${id} ← ${pid.padEnd(8)} ${desc.slice(0, 80)}`);
  }

  // === 5. 检查是否有 compaction 条目 ===
  console.log("\n" + "═".repeat(72));
  console.log("🔍 Compaction 检查（PI 唯一的'记忆'机制）");
  console.log("═".repeat(72));

  const compactions = entries.filter((e) => e.type === "compaction");
  if (compactions.length === 0) {
    console.log(`\n   ⚠️ 此会话没有 compaction 条目`);
    console.log(`   触发条件: contextTokens > contextWindow - reserveTokens(默认 16384)`);
    console.log(`   即上下文接近窗口上限时才被动触发`);
  } else {
    for (const c of compactions) {
      console.log(`\n   Compaction @ ${c.timestamp}:`);
      console.log(`     tokensBefore: ${c.tokensBefore}`);
      console.log(`     summary (前 500 字符):`);
      console.log(`     ${(c.summary ?? "").slice(0, 500)}`);
    }
  }

  // === 6. 扫描所有会话，看是否有 compaction ===
  console.log("\n" + "═".repeat(72));
  console.log("📊 全局扫描：所有会话的 compaction 情况");
  console.log("═".repeat(72));

  let totalSessions = 0;
  let sessionsWithCompaction = 0;
  let totalCompactions = 0;
  const allSessionDirs = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];

  for (const dir of allSessionDirs) {
    const dirPath = resolve(sessionsDir, dir);
    try {
      const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        totalSessions++;
        const content = readFileSync(resolve(dirPath, f), "utf-8");
        const compCount = (content.match(/"type":"compaction"/g) || []).length;
        if (compCount > 0) {
          sessionsWithCompaction++;
          totalCompactions += compCount;
        }
      }
    } catch {}
  }

  console.log(`\n   总会话数:           ${totalSessions}`);
  console.log(`   有 compaction 的:   ${sessionsWithCompaction} (${totalSessions > 0 ? Math.round(sessionsWithCompaction / totalSessions * 100) : 0}%)`);
  console.log(`   compaction 总次数: ${totalCompactions}`);

  // === 7. 关键结论 ===
  console.log("\n" + "═".repeat(72));
  console.log("💡 记忆机制边界分析");
  console.log("═".repeat(72));

  console.log(`
   PI 的"记忆"能力清单：
   ┌─────────────────────────────────┬──────────┬──────────┐
   │ 机制                            │ 跨会话?  │ 主动?    │
   ├─────────────────────────────────┼──────────┼──────────┤
   │ AGENTS.md / context files       │ ✅ 是    │ ✅ 静态  │
   │ SYSTEM.md / APPEND_SYSTEM.md    │ ✅ 是    │ ✅ 静态  │
   │ Skills                          │ ✅ 是    │ ✅ 静态  │
   │ settings.json                   │ ✅ 是    │ ✅ 静态  │
   │ Extensions                      │ ✅ 是    │ ✅ 代码  │
   │ Session resume (-r/-c)          │ ❌ 单会话│ 手动     │
   │ Compaction summary              │ ❌ 单会话│ ❌ 被动  │
   │ 跨会话用户画像聚合              │ ❌ 不存在│ ❌ N/A   │
   └─────────────────────────────────┴──────────┴──────────┘

   🔴 关键空白：PI 没有"跨会话长期记忆"。
   - compaction 的 "Constraints & Preferences" 只在单会话内有效
   - 新会话不会读取旧会话的 compaction summary
   - 用户的偏好（"我喜欢用 tabs"）需要在每个新会话重新声明

   🟢 这正是 Stage 3 remember 扩展要填补的：
   - 用 extension 的 before_agent_start 钩子
   - 从持久化文件（~/.pi/agent/memory.json）读取用户偏好
   - 注入到每轮的 system prompt
   - 实现"跨会话"的记忆效果
  `);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
