// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialSourceSheet } from "./MaterialSourceSheet";

function setup(over: Partial<React.ComponentProps<typeof MaterialSourceSheet>> = {}) {
  const cb = {
    onClose: vi.fn(),
    onUpload: vi.fn(),
    onToggleCamera: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onSelectSource: vi.fn(),
    onDrive: vi.fn(),
  };
  render(<MaterialSourceSheet {...cb} {...over} />);
  return cb;
}

describe("MaterialSourceSheet（05-2 手段選択シート）", () => {
  afterEach(() => cleanup());

  it("ダイアログとして各手段（カメラ/アップロード/画面共有/Drive）を出す", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "資料の追加方法" })).toBeTruthy();
    expect(screen.getByText("カメラで撮影")).toBeTruthy();
    expect(screen.getByText("ファイルをアップロード")).toBeTruthy();
    expect(screen.getByText("画面を共有")).toBeTruthy();
    expect(screen.getByText("Google ドライブから選ぶ")).toBeTruthy();
  });

  it("アップロードを選ぶと onUpload と計測（upload）が走る", () => {
    const cb = setup();
    fireEvent.click(screen.getByText("ファイルをアップロード"));
    expect(cb.onUpload).toHaveBeenCalledTimes(1);
    expect(cb.onSelectSource).toHaveBeenCalledWith("upload");
  });

  it("カメラ/画面共有はトグルを呼び、種別を計測する", () => {
    const cb = setup();
    fireEvent.click(screen.getByText("カメラで撮影"));
    expect(cb.onToggleCamera).toHaveBeenCalledTimes(1);
    expect(cb.onSelectSource).toHaveBeenCalledWith("camera");
    fireEvent.click(screen.getByText("画面を共有"));
    expect(cb.onToggleScreenShare).toHaveBeenCalledTimes(1);
    expect(cb.onSelectSource).toHaveBeenCalledWith("screen");
  });

  it("トグル未指定（LiveKit 非搭載文脈・#222 再利用）ならカメラ/画面共有の行を出さない", () => {
    setup({ onToggleCamera: undefined, onToggleScreenShare: undefined });
    expect(screen.queryByText("カメラで撮影")).toBeNull();
    expect(screen.queryByText("画面を共有")).toBeNull();
    // アップロードと Drive は常に出る。
    expect(screen.getByText("ファイルをアップロード")).toBeTruthy();
    expect(screen.getByText("Google ドライブから選ぶ")).toBeTruthy();
  });

  it("active なカメラ/画面共有は ON（aria-pressed=true）として示す", () => {
    setup({ cameraActive: true, screenShareActive: true });
    expect(
      screen.getByRole("button", { name: "カメラの起動/停止" }).getAttribute("aria-pressed"),
    ).toBe("true");
    // 画面共有は active 時にラベルが「停止」へ変わる。
    expect(screen.getByText("画面共有を停止")).toBeTruthy();
  });

  it("Drive を押すと onDrive（Picker）を呼び、種別（drive）を計測する（ADR-0049）", () => {
    const cb = setup();
    fireEvent.click(screen.getByText("Google ドライブから選ぶ"));
    expect(cb.onDrive).toHaveBeenCalledTimes(1);
    expect(cb.onSelectSource).toHaveBeenCalledWith("drive");
  });

  it("キャンセル・背景・ESC で閉じる（a11y）", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(cb.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(cb.onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cb.onClose).toHaveBeenCalledTimes(3);
  });

  it("カメラ/画面共有の開始失敗（error）を alert として出す", () => {
    setup({ error: "カメラを開始できませんでした。ブラウザのカメラ許可をご確認ください。" });
    expect(screen.getByRole("alert").textContent).toMatch(/カメラを開始できませんでした/);
  });

  it("error 未指定なら alert を出さない", () => {
    setup();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("開いた直後はシート内（閉じる）へフォーカスを移す（フォーカストラップの起点）", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
  });
});
