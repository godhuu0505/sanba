import { describe, expect, it } from "vitest";

import { categoryPresentation, detectionPresentation, priorityLabel } from "./mapping";

// モード別語彙（FR-2.4 / ADR-0032）: end_user では開発語彙（矛盾/抜け・MoSCoW・非機能）を
// 利用者向けに切替える。developer（既定）は従来表示のまま。

describe("detectionPresentation（モード別語彙）", () => {
  it("developer（既定）は従来の開発語彙", () => {
    expect(detectionPresentation("contradiction").label).toBe("矛盾");
    expect(detectionPresentation("gap").label).toBe("抜け");
    expect(detectionPresentation("ambiguous").label).toBe("不明瞭");
  });

  it("end_user は利用者向け文言に切替わる（色・アイコンは共有）", () => {
    const dev = detectionPresentation("contradiction");
    const eu = detectionPresentation("contradiction", "end_user");
    expect(eu.label).toBe("食い違い");
    expect(eu.ariaLabel).toContain("食い違い");
    expect(eu.color).toBe(dev.color); // 色トークンは共有（色のみ非依存の原則は不変）
    expect(eu.icon).toBe(dev.icon);
    expect(detectionPresentation("gap", "end_user").label).toBe("確認");
    expect(detectionPresentation("ambiguous", "end_user").label).toBe("あいまい");
  });
});

describe("categoryPresentation（モード別語彙）", () => {
  it("end_user は『非機能』等の技術用語を出さない", () => {
    expect(categoryPresentation("non_functional").label).toBe("非機能");
    expect(categoryPresentation("non_functional", "end_user").label).toBe("使い心地");
    expect(categoryPresentation("scope", "end_user").label).toBe("範囲");
    // 未知カテゴリも end_user では中立語に丸める。
    expect(categoryPresentation("unknown_cat", "end_user").label).toBe("要望");
  });
});

describe("priorityLabel（モード別語彙）", () => {
  it("developer（既定）は MoSCoW 表記", () => {
    expect(priorityLabel("must")).toBe("Must 必須");
  });

  it("end_user は MoSCoW（Must/Should/...）を露出させない", () => {
    for (const p of ["must", "should", "could", "wont"]) {
      const label = priorityLabel(p, "end_user");
      expect(label).not.toMatch(/must|should|could|won/i);
      expect(label).not.toMatch(/MoSCoW/i);
    }
    expect(priorityLabel("must", "end_user")).toBe("ぜひ必要");
    // 未知の優先度も英語の内部値をそのまま出さない。
    expect(priorityLabel("unknown", "end_user")).toBe("その他");
  });
});
