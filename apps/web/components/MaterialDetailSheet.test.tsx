// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialDetailSheet } from "./MaterialDetailSheet";
import type { MaterialDetail } from "../lib/realtime/selectors";

const detail = (over: Partial<MaterialDetail> = {}): MaterialDetail => ({
  id: "a1",
  name: "一覧_モック.png",
  pct: 100,
  status: "done",
  extracted: ["3カラム一覧", "フィルタUI"],
  conflicts: [{ summary: "画面に検索バーが無いが『検索したい』と発言", refs: ["u1"] }],
  analysisReady: true,
  ...over,
});

describe("MaterialDetailSheet（05-1 資料詳細）", () => {
  afterEach(() => cleanup());

  it("ダイアログとして開き、抽出要件チップと言葉×画の矛盾を種別別に出す", () => {
    render(<MaterialDetailSheet detail={detail()} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "資料の詳細" });
    expect(dialog).toBeTruthy();

    // 種別①: 抽出した要件（チップ）。
    const extracted = within(dialog).getByRole("region", { name: "抽出した要件" });
    expect(within(extracted).getByText("3カラム一覧")).toBeTruthy();
    expect(within(extracted).getByText("フィルタUI")).toBeTruthy();

    // 種別②: 言葉×画の矛盾。
    const conflicts = within(dialog).getByRole("region", { name: "言葉×画の矛盾" });
    expect(within(conflicts).getByText(/検索バーが無いが/)).toBeTruthy();
    expect(screen.getByText("✓ 解析済")).toBeTruthy();
  });

  it("矛盾バッジは色のみに依らずラベル＋現代語の説明（ariaLabel）を伴う（ADR-0017）", () => {
    render(<MaterialDetailSheet detail={detail()} onClose={vi.fn()} />);
    // mapping.ts（矛盾）の ariaLabel="矛盾を検知" を持つ。見た目に依らず判別できる。
    expect(screen.getByRole("status", { name: "矛盾を検知" })).toBeTruthy();
  });

  it("detection が無い視覚解析のみの矛盾でも表示できる（#202 AC）", () => {
    render(
      <MaterialDetailSheet
        detail={detail({ conflicts: [{ summary: "図にだけ存在する導線", refs: [] }] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("図にだけ存在する導線")).toBeTruthy();
  });

  it("解析完了で矛盾が無いときだけ『見つかっていません』と断定する", () => {
    render(<MaterialDetailSheet detail={detail({ conflicts: [] })} onClose={vi.fn()} />);
    expect(screen.getByText(/矛盾は見つかっていません/)).toBeTruthy();
  });

  it("詳細未取得（再接続後の done 行など）は空を断定せず未取得を示す（Codex P2 #1）", () => {
    // analysisReady=false: extracted/conflicts が空でも「無し」と断定しない（一覧の件数と矛盾させない）。
    render(
      <MaterialDetailSheet
        detail={detail({ extracted: [], conflicts: [], analysisReady: false })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/見つかっていません/)).toBeNull();
    expect(screen.queryByText(/抽出された要件はありません/)).toBeNull();
    expect(screen.getAllByText(/取得できていません/).length).toBeGreaterThan(0);
  });

  it("解析中は進捗バー（aria-valuenow）と % を出し、矛盾なしと断定しない（Codex P2 #3）", () => {
    render(
      <MaterialDetailSheet
        detail={detail({ status: "analyzing", pct: 62, extracted: [], conflicts: [], analysisReady: false })}
        onClose={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "解析の進捗" });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText("62%")).toBeTruthy();
    expect(screen.queryByText(/見つかっていません/)).toBeNull();
  });

  it("✕ / 暗幕 / ESC で閉じる", () => {
    const onClose = vi.fn();
    render(<MaterialDetailSheet detail={detail()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("『会話で確認』は onConfirmInConversation を呼ぶ（指定時のみ表示）", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <MaterialDetailSheet detail={detail()} onClose={vi.fn()} onConfirmInConversation={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /会話で確認/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(<MaterialDetailSheet detail={detail()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /会話で確認/ })).toBeNull();
  });
});
