/**
 * 实验 03（修正版）：直接验证 buildSystemPrompt + 手动加载资源
 *
 * 绕过 jiti 扩展加载问题，专注验证：
 * 1. system prompt 是怎么从片段拼装的
 * 2. AGENTS.md 怎么注入 <project_context>
 * 3. skills 怎么注入 <available_skills>（progressive disclosure）
 * 4. APPEND_SYSTEM.md 怎么追加
 *
 * 运行方式：
 *   ./pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/03-system-prompt.ts
 */

import { buildSystemPrompt } from "../pi/packages/coding-agent/src/core/system-prompt.ts";
import { formatSkillsForPrompt, type Skill } from "../pi/packages/coding-agent/src/core/skills.ts";
import { readFileSync } from "node:fs";

async function main() {
  // === 1. 手动加载 PI 仓库自己的个性化资源 ===
  const piRoot = process.cwd() + "/pi";

  // 加载 AGENTS.md（context file）
  const agentsMd = readFileSync(`${piRoot}/AGENTS.md`, "utf-8");
  const contextFiles = [{ path: `${piRoot}/AGENTS.md`, content: agentsMd }];

  // 加载 skill（add-llm-provider.md）
  const skillContent = readFileSync(`${piRoot}/.pi/skills/add-llm-provider.md`, "utf-8");
  // 解析 frontmatter
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const skillBody = fmMatch ? fmMatch[2] : skillContent;
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  const skills: Skill[] = [{
    name: nameMatch ? nameMatch[1].trim() : "add-llm-provider",
    description: descMatch ? descMatch[1].trim() : "",
    filePath: `${piRoot}/.pi/skills/add-llm-provider.md`,
    content: skillBody,
    source: "project",
  }];

  console.log("📦 加载的个性化资源：");
  console.log(`   context file: AGENTS.md (${agentsMd.length} 字符)`);
  console.log(`   skill: ${skills[0].name} - ${skills[0].description.slice(0, 60)}...`);
  console.log("");

  // === 2. 场景 A：默认 prompt（最常见）===
  console.log("═".repeat(70));
  console.log("场景 A：默认 system prompt（无 SYSTEM.md 覆盖）");
  console.log("═".repeat(70));
  const promptA = buildSystemPrompt({
    cwd: piRoot,
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: {
      read: "Read the contents of a file (text or image)",
      bash: "Execute a shell command",
      edit: "Edit a file with string replacement",
      write: "Write content to a file",
    },
    promptGuidelines: ["Use bash for file operations like ls, rg, find"],
    contextFiles,
    skills,
  });
  console.log(promptA);
  console.log("═".repeat(70));
  console.log(`长度: ${promptA.length} 字符\n\n`);

  // === 3. 场景 B：有 SYSTEM.md（完全替换）===
  console.log("═".repeat(70));
  console.log("场景 B：有 SYSTEM.md（完全替换默认 prompt）");
  console.log("═".repeat(70));
  const promptB = buildSystemPrompt({
    cwd: piRoot,
    customPrompt: "你是一个 Python 专家助手。只回答 Python 相关问题。",
    appendSystemPrompt: "额外规则：始终用中文回复。",  // 模拟 APPEND_SYSTEM.md
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read file", bash: "Run command" },
    contextFiles,
    skills,
  });
  console.log(promptB);
  console.log("═".repeat(70));
  console.log(`长度: ${promptB.length} 字符\n\n`);

  // === 4. 单独看 skills 的 progressive disclosure 格式 ===
  console.log("═".repeat(70));
  console.log("🔍 <available_skills> 的 XML 格式（progressive disclosure）");
  console.log("═".repeat(70));
  console.log(formatSkillsForPrompt(skills));
  console.log("═".repeat(70));
  console.log("\n💡 注意：这里只注入了 name + description + location");
  console.log("   完整的 skill 内容（" + skills[0].content.length + " 字符）不在 prompt 里！");
  console.log("   模型需要时，会用 read 工具读 filePath 指向的文件。");
  console.log("   这就是 progressive disclosure（渐进式披露）——省 token 的关键设计。");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
