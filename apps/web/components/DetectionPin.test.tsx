// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DetectionPin } from "./DetectionPin";

describe("DetectionPin（選択肢なし検知の読み取り専用ピン・#208）", () => {
  afterEach(() => cleanup());

  it("要約を status として出し、抜けバッジ（ラベル＋アイコン）を添える", () => {
    render(<DetectionPin summary="『該当なし』の空状態が未定義。" kind="gap" />);
    const pin = screen.getByRole("status");
    expect(pin.textContent).toContain("『該当なし』の空状態が未定義。");
    // 色のみに依存しない: ラベル「抜け」＋アイコン「◇」＋ aria-label。
    expect(screen.getByLabelText("抜け（未定義）を検知").textContent).toContain("抜け");
  });

  it("矛盾種別なら矛盾バッジを出す", () => {
    render(<DetectionPin summary="関連度順か新着順か。" kind="contradiction" />);
    expect(screen.getByLabelText("矛盾を検知").textContent).toContain("矛盾");
  });

  it("読み取り専用: 回答ボタンを持たない", () => {
    render(<DetectionPin summary="抜けの要約" kind="gap" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
