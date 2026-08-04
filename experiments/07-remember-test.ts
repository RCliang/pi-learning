import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const MEMORY_PATH = join(homedir(), ".pi", "agent", "memory.json");

function loadMemory() {
  if (!existsSync(MEMORY_PATH)) return { entries: [], version: 1 };
  return JSON.parse(readFileSync(MEMORY_PATH, "utf-8"));
}
function saveMemory(s: any) {
  const dir = dirname(MEMORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(s, null, 2));
}
function removeMemory(idOrAll: string) {
  const s = loadMemory();
  if (idOrAll === "all") { const c = s.entries.length; s.entries = []; saveMemory(s); return c; }
  const b = s.entries.length;
  s.entries = s.entries.filter((e: any) => e.id !== idOrAll);
  saveMemory(s);
  return b - s.entries.length;
}

console.log("=== 单元测试 forget 逻辑 ===");
const before = loadMemory();
console.log("当前记忆数:", before.entries.length);
for (const e of before.entries) console.log("  -", e.id, e.content);

const id = before.entries[0]?.id;
if (id) {
  const r = removeMemory(id);
  console.log(`\n删除 id=${id}: 删除了 ${r} 条`);
  console.log("剩余:", loadMemory().entries.length);
}
const rAll = removeMemory("all");
console.log(`\n删除 all: 删除了 ${rAll} 条`);
console.log("剩余:", loadMemory().entries.length);
