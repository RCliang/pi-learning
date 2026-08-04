/**
 * 实验 04：验证 Face 3 — Skills 真实发现机制
 *
 * 目标：调用 PI 的真实 loadSkills() 函数，确认我自己写的 skill 文件
 *       （playground/.pi/skills/code-review-checklist.md）能被正确发现、
 *       校验通过、并注入 <available_skills> XML 块。
 *
 * 关键验证点：
 *   1. loadSkills 是否扫描到 .pi/skills/*.md
 *   2. frontmatter 的 name/description 是否被正确解析
 *   3. formatSkillsForPrompt 是否只输出 name+description+location（progressive disclosure）
 *   4. 如果 name 违反规则（大写/下划线）是否产生 diagnostics
 *
 * 运行方式（在 E:\2026projects\pi-learning 下）：
 *   pi/node_modules/.bin/tsx --tsconfig pi/tsconfig.json experiments/04-skills-discovery.ts
 */

import {
  loadSkills,
  formatSkillsForPrompt,
  type LoadSkillsOptions,
} from "../pi/packages/coding-agent/src/core/skills.ts";
import { buildSystemPrompt } from "../pi/packages/coding-agent/src/core/system-prompt.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

async function main() {
  // 实验脚本位于 E:\2026projects\pi-learning\experiments\
  // 用 import.meta.url 推断项目根目录，避免依赖 process.cwd()
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const playgroundDir = resolve(projectRoot, "playground");
  // 全局 agentDir 用 PI 自己的（避免污染 ~/.pi；这里只测项目级 skill）
  const agentDir = resolve(projectRoot, "pi/.pi");

  console.log("═".repeat(72));
  console.log("Face 3 — Skills 真实发现机制验证");
  console.log("═".repeat(72));
  console.log(`cwd        = ${playgroundDir}`);
  console.log(`agentDir   = ${agentDir}`);
  console.log(`skills 目录 = ${playgroundDir}/.pi/skills/`);
  console.log();

  // === 1. 调用真实的 loadSkills ===
  const opts: LoadSkillsOptions = {
    cwd: playgroundDir,
    agentDir,
    skillPaths: [],
    includeDefaults: true, // 同时扫描 agentDir/skills 和 cwd/.pi/skills
  };

  const result = loadSkills(opts);

  console.log("─── 发现结果 ───");
  console.log(`找到 ${result.skills.length} 个 skill，${result.diagnostics.length} 条诊断信息`);
  console.log();

  if (result.diagnostics.length > 0) {
    console.log("⚠️ 诊断信息：");
    for (const d of result.diagnostics) {
      console.log(`   [${d.type}] ${d.message} @ ${d.path}`);
    }
    console.log();
  }

  // === 2. 列出发现的每个 skill ===
  console.log("─── 发现的 skills（progressive disclosure 注入内容）───");
  for (const s of result.skills) {
    console.log(`\n• name:        ${s.name}`);
    console.log(`  description: ${s.description.slice(0, 80)}${s.description.length > 80 ? "..." : ""}`);
    console.log(`  filePath:    ${s.filePath}`);
    console.log(`  disableModelInvocation: ${s.disableModelInvocation}`);
  }
  console.log();

  // === 3. 验证 progressive disclosure：只注入 name+desc+location ===
  console.log("═".repeat(72));
  console.log("🔍 formatSkillsForPrompt 输出（注入 system prompt 的真实内容）");
  console.log("═".repeat(72));
  const skillsXml = formatSkillsForPrompt(result.skills);
  console.log(skillsXml);
  console.log();

  // 关键断言：XML 里不应该包含 skill 正文的关键词（如"安全性检查"）
  const fullContent = readFileSync(
    resolve(playgroundDir, ".pi/skills/code-review-checklist.md"),
    "utf-8"
  );
  const bodyMarker = "安全性检查"; // 只在正文里出现的词
  const inXml = skillsXml.includes(bodyMarker);
  console.log(`💡 Progressive Disclosure 验证：`);
  console.log(`   正文标记 "${bodyMarker}" 是否泄露到 prompt?  ${inXml ? "❌ 是（失败）" : "✅ 否（成功）"}`);
  console.log(`   prompt 里只有 name/description/location，正文 ${fullContent.length} 字符未注入`);
  console.log();

  // === 4. 完整 system prompt 片段（skill 块所在上下文）===
  console.log("═".repeat(72));
  console.log("📋 完整 system prompt（截取 skills 相关部分）");
  console.log("═".repeat(72));
  const fullPrompt = buildSystemPrompt({
    cwd: playgroundDir,
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: {
      read: "Read file contents",
      bash: "Execute shell command",
      edit: "Edit file with replacement",
      write: "Write file",
    },
    skills: result.skills,
    contextFiles: [],
  });
  const skillsIdx = fullPrompt.indexOf("<available_skills>");
  const cwdIdx = fullPrompt.indexOf("Current working directory");
  if (skillsIdx >= 0) {
    console.log(fullPrompt.slice(skillsIdx, cwdIdx > 0 ? cwdIdx : undefined));
  } else {
    console.log("⚠️ 未找到 <available_skills> 块（skills 为空？）");
  }
  console.log();

  // === 5. 反向测试：name 校验规则 ===
  console.log("═".repeat(72));
  console.log("🧪 反向测试：写一个违反命名规则的 skill，看 diagnostics");
  console.log("═".repeat(72));
  const badSkillDir = resolve(playgroundDir, ".pi/skills");
  const badSkillPath = resolve(badSkillDir, "_BadName_Invalid.md");
  writeFileSync(
    badSkillPath,
    `---
name: Invalid_Name
description: 测试违反命名规则的 skill（大写 + 下划线）
---

# 不应该被接受
`
  );
  const result2 = loadSkills(opts);
  const badDiag = result2.diagnostics.filter((d) => d.path === badSkillPath);
  console.log(`违规 skill 诊断：${badDiag.length} 条`);
  for (const d of badDiag) {
    console.log(`   [${d.type}] ${d.message}`);
  }
  // 清理
  unlinkSync(badSkillPath);
  console.log("（已清理测试文件）");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
