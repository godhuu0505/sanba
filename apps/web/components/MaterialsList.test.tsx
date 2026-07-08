// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialsList, type MaterialItem } from "./MaterialsList";

const item = (over: Partial<MaterialItem>): MaterialItem => ({
  id: "a1",
  name: "資料.png",
  pct: 100,
  status: "done",
  ...over,
});

describe("MaterialsList（参考資料タブ・解析進捗つき）", () => {
  afterEach(() => cleanup());

  it("空のときは未投入メッセージと『参考資料を追加』を出す", () => {
    render(<MaterialsList items={[]} onAdd={vi.fn()} />);
    expect(screen.getByText(/まだありません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /参考資料を追加/ })).toBeTruthy();
  });

  it("解析中はファイル名・進捗バー(aria-valuenow)・% を出す", () => {
    render(
      <MaterialsList
        items={[item({ id: "a1", name: "一覧_モック.png", pct: 62, status: "analyzing" })]}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText("一覧_モック.png")).toBeTruthy();
    expect(screen.getByText(/解析中/)).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText(/62%/)).toBeTruthy();
  });

  it("完了は『解析済』を出す（進捗バーは出さない）", () => {
    render(<MaterialsList items={[item({ name: "PRD.pdf", status: "done" })]} onAdd={vi.fn()} />);
    expect(screen.getByText("PRD.pdf")).toBeTruthy();
    expect(screen.getByText(/解析済/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("失敗は再試行ボタンを出す（onRetry 指定時）", () => {
    const onRetry = vi.fn();
    render(<MaterialsList items={[item({ id: "x", status: "failed" })]} onAdd={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /再試行/ }));
    expect(onRetry).toHaveBeenCalledWith("x");
  });

  it("onRetry 未指定なら再試行ボタンを出さない", () => {
    render(<MaterialsList items={[item({ status: "failed" })]} onAdd={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /再試行/ })).toBeNull();
  });

  it("done の行は詳細導線（ボタン）になり onOpenDetail(id) を呼ぶ", () => {
    const onOpenDetail = vi.fn();
    render(
      <MaterialsList
        items={[item({ id: "a1", name: "一覧_モック.png", status: "done", extracted: 2 })]}
        onAdd={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "参考資料 一覧_モック.png の詳細を開く" }));
    expect(onOpenDetail).toHaveBeenCalledWith("a1");
  });

  it("解析中/失敗/アップロード中の行は詳細導線を出さない（中身が未確定＋進捗バーを button に入れない）", () => {
    const onOpenDetail = vi.fn();
    render(
      <MaterialsList
        items={[
          item({ id: "a2", name: "図解.png", pct: 50, status: "analyzing" }),
          item({ id: "f1", name: "壊れ.png", status: "failed" }),
          item({ id: "u1", name: "送信中.png", pct: 10, status: "uploading" }),
        ]}
        onAdd={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );
    expect(screen.queryByRole("button", { name: /詳細を開く/ })).toBeNull();
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
  });

  it("onOpenDetail 未指定なら行はボタンにしない", () => {
    render(<MaterialsList items={[item({ id: "a1", status: "done" })]} onAdd={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /詳細を開く/ })).toBeNull();
  });

  it("『参考資料を追加』で onAdd が呼ばれる", () => {
    const onAdd = vi.fn();
    render(<MaterialsList items={[]} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /参考資料を追加/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  describe("中断（✕ 中断）", () => {
    it("解析中/アップロード中は onCancel 指定時に『✕ 中断』を出す", () => {
      render(
        <MaterialsList
          items={[
            item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" }),
            item({ id: "a2", name: "up.png", pct: 0, status: "uploading" }),
          ]}
          onAdd={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "mock.png の解析を中断" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "up.png の解析を中断" })).toBeTruthy();
    });

    it("onCancel 未指定なら中断ボタンを出さない", () => {
      render(
        <MaterialsList
          items={[item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" })]}
          onAdd={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /中断/ })).toBeNull();
    });

    it("完了/失敗の行には中断ボタンを出さない（解析/アップロード中のみ）", () => {
      render(
        <MaterialsList
          items={[
            item({ id: "d1", name: "done.png", status: "done" }),
            item({ id: "f1", name: "fail.png", status: "failed" }),
          ]}
          onAdd={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /中断/ })).toBeNull();
    });

    it("中断押下で確認ダイアログ（破棄の警告つき）を出す", () => {
      render(
        <MaterialsList
          items={[item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" })]}
          onAdd={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "mock.png の解析を中断" }));
      const dialog = screen.getByRole("dialog", { name: "中断の確認" });
      expect(dialog).toBeTruthy();
      expect(screen.getByText(/「mock\.png」の解析を中断します。途中までの結果は破棄されます/)).toBeTruthy();
    });

    it("ダイアログで『中断する』を押すと onCancel(id) を呼んで閉じる", () => {
      const onCancel = vi.fn();
      render(
        <MaterialsList
          items={[item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "mock.png の解析を中断" }));
      fireEvent.click(screen.getByRole("button", { name: "中断する" }));
      expect(onCancel).toHaveBeenCalledWith("a1");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("ダイアログで『続ける』を押すと破棄せず閉じる（継続）", () => {
      const onCancel = vi.fn();
      render(
        <MaterialsList
          items={[item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "mock.png の解析を中断" }));
      fireEvent.click(screen.getByRole("button", { name: "続ける" }));
      expect(onCancel).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("確認中に対象が完了（サーバ反映済み）になったら確認を無効化し破棄しない（Codex P2）", () => {
      const onCancel = vi.fn();
      const { rerender } = render(
        <MaterialsList
          items={[item({ id: "local:0", name: "up.png", pct: 0, status: "uploading" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "up.png の解析を中断" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      rerender(
        <MaterialsList
          items={[item({ id: "hash-1", name: "up.png", pct: 100, status: "done" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("確認中に対象が id 差し替え後も解析中なら確認を保ち、新 id で中断できる（動画・Codex P2）", () => {
      const onCancel = vi.fn();
      const { rerender } = render(
        <MaterialsList
          items={[item({ id: "local:0", name: "clip.mp4", pct: 0, status: "uploading" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "clip.mp4 の解析を中断" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      rerender(
        <MaterialsList
          items={[item({ id: "vid-1", name: "clip.mp4", pct: 0, status: "analyzing" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
          aliases={new Map([["local:0", "vid-1"]])}
        />,
      );
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "中断する" }));
      expect(onCancel).toHaveBeenCalledWith("vid-1");
    });

    it("同名の別素材へ中断対象をすり替えない（一意 id で追跡・Codex P2）", () => {
      const onCancel = vi.fn();
      const { rerender } = render(
        <MaterialsList
          items={[
            item({ id: "local:0", name: "clip.mp4", pct: 0, status: "uploading" }),
            item({ id: "local:1", name: "clip.mp4", pct: 0, status: "uploading" }),
          ]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getAllByRole("button", { name: "clip.mp4 の解析を中断" })[0]);
      expect(screen.getByRole("dialog")).toBeTruthy();
      rerender(
        <MaterialsList
          items={[
            item({ id: "hash-0", name: "clip.mp4", pct: 100, status: "done" }),
            item({ id: "local:1", name: "clip.mp4", pct: 0, status: "uploading" }),
          ]}
          onAdd={vi.fn()}
          onCancel={onCancel}
          aliases={new Map([["local:0", "hash-0"]])}
        />,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("ESC でダイアログを閉じる（継続・a11y）", () => {
      const onCancel = vi.fn();
      render(
        <MaterialsList
          items={[item({ id: "a1", name: "mock.png", pct: 40, status: "analyzing" })]}
          onAdd={vi.fn()}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "mock.png の解析を中断" }));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
