import { describe, expect, it } from "vitest";

import { categoryPresentation, detectionPresentation, priorityLabel } from "./mapping";

describe("detectionPresentation（単一文言・平易）", () => {
  it("検知は平易な単一文言で出す", () => {
    expect(detectionPresentation("contradiction").label).toBe("食い違い");
    expect(detectionPresentation("gap").label).toBe("確認したい点");
    expect(detectionPresentation("ambiguous").label).toBe("あいまい");
  });

  it("色・アイコン・aria を伴う（色のみに依存しない）", () => {
    const p = detectionPresentation("contradiction");
    expect(p.ariaLabel).toContain("食い違い");
    expect(p.color).toBeTruthy();
    expect(p.Icon).toBeTruthy();
  });
});

describe("categoryPresentation（単一文言・開発語彙を出さない）", () => {
  it("分類は平易語で、『非機能』等の技術用語を出さない", () => {
    expect(categoryPresentation("functional").label).toBe("機能");
    expect(categoryPresentation("non_functional").label).toBe("使い心地");
    expect(categoryPresentation("constraint").label).toBe("前提");
    expect(categoryPresentation("scope").label).toBe("範囲");
    expect(categoryPresentation("open_question").label).toBe("確認中");
    expect(categoryPresentation("unknown_cat").label).toBe("その他");
    for (const c of ["functional", "non_functional", "constraint", "scope", "open_question"]) {
      expect(categoryPresentation(c).label).not.toMatch(/非機能|制約|境界|未解決/);
    }
  });
});

describe("priorityLabel（単一文言・MoSCoW を出さない）", () => {
  it("優先度は平易語で出す", () => {
    expect(priorityLabel("must")).toBe("ぜひ必要");
    expect(priorityLabel("should")).toBe("あると助かる");
    expect(priorityLabel("could")).toBe("できれば");
    expect(priorityLabel("wont")).toBe("今回は見送り");
    expect(priorityLabel("unknown")).toBe("その他");
  });

  it("MoSCoW（Must/Should/...）をラベルに露出させない", () => {
    for (const p of ["must", "should", "could", "wont"]) {
      const label = priorityLabel(p);
      expect(label).not.toMatch(/must|should|could|won/i);
      expect(label).not.toMatch(/MoSCoW/i);
    }
  });
});
