#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps/web");
const require = createRequire(path.join(webRoot, "package.json"));
const { parse } = require("@babel/parser");

const DEFAULT_GLOBS = [
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "e2e/**/*.ts",
  "*.{mjs}",
  "playwright.config.ts",
  "vitest.config.ts",
];

const KEEP_PATTERNS = [
  /^\s*eslint-disable/,
  /^\s*@ts-ignore/,
  /^\s*@ts-expect-error/,
  /^\s*prettier-ignore/,
  /^\s*@vitest-environment/,
  /^\s*istanbul ignore/,
  /^\s*biome-ignore/,
  /^\s*\/ <reference /,
];

function findViolations(file) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    attachComment: true,
  });
  return (ast.comments ?? [])
    .filter((c) => !KEEP_PATTERNS.some((re) => re.test(c.value)))
    .map((c) => ({ line: c.loc.start.line, text: c.value.trim().slice(0, 80) }));
}

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args.map((a) => (path.isAbsolute(a) ? a : path.join(repoRoot, a)))
    : DEFAULT_GLOBS.flatMap((g) => globSync(g, { cwd: webRoot }).map((f) => path.join(webRoot, f)));

let exitCode = 0;
for (const file of files) {
  const rel = path.relative(repoRoot, file);
  let violations;
  try {
    violations = findViolations(file);
  } catch (e) {
    console.error(`${rel}: コメント検査に失敗しました（検査不能）: ${e.message}`);
    exitCode = 1;
    continue;
  }
  for (const { line, text } of violations) {
    console.log(`${rel}:${line}: disallowed comment: ${text}`);
    exitCode = 1;
  }
}

if (exitCode) {
  console.error(
    "\nコメントは原則禁止です（CLAUDE.md）。設計判断の理由はコミットメッセージ/PR説明/ADRに書いてください。" +
      "eslint-disable / @ts-ignore / @ts-expect-error / prettier-ignore / @vitest-environment 等は許可されています。",
  );
}

process.exit(exitCode);
