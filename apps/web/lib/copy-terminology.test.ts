import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "design"]);
const SELF = relative(ROOT, __filename);

const BANNED_TERMS = [
  "問答",
  "壁打ち",
  "要件サンバ",
  "要件絵巻",
  "産婆さん",
  "深掘りリンク",
  "深掘りセッション",
  "深掘りの対象",
  "どう並ぶ",
  "関連・出所",
  "矛盾",
  "抜け",
  "不明瞭",
];

const BARE_MUTE = /(?<!スピーカー)消音/;

function isSourceFile(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx");
}

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, files);
    } else if (isSourceFile(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("UI コピーの禁止バリアント走査（ADR-0054 再ゆれ防止）", () => {
  it("旧文言・演出語のバリアントが app/components/lib のソースに残っていない", () => {
    const files = SCAN_DIRS.flatMap((dir) => collectFiles(join(ROOT, dir))).filter(
      (f) => relative(ROOT, f) !== SELF,
    );

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const relPath = relative(ROOT, file);
      for (const term of BANNED_TERMS) {
        if (content.includes(term)) {
          violations.push(`${relPath}: 禁止バリアント "${term}" を検出`);
        }
      }
      if (BARE_MUTE.test(content)) {
        violations.push(`${relPath}: "スピーカー消音" を伴わない裸の "消音" を検出`);
      }
    }

    expect(violations).toEqual([]);
  });
});
