// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShell } from "./ConversationShell";

const mini = { requirements: 8, unresolved: 2, materials: 3, analyzing: true };

function renderShell(onEnd = vi.fn()) {
  render(
    <ConversationShell
      mini={mini}
      elapsed="12:46"
      onEnd={onEnd}
      tabs={{
        history: <div>会話本文</div>,
        files: <div>ファイル本文</div>,
        scroll: <div>絵巻本文</div>,
      }}
      choicePin={<div>問いピン</div>}
      bottomBar={<div>下部バー</div>}
    />,
  );
  return onEnd;
}

describe("ConversationShell（共通シェル）", () => {
  afterEach(() => cleanup());

  it("固定ヘッダ（問答・REC・終了）とミニ状況を表示する", () => {
    renderShell();
    expect(screen.getByRole("heading", { name: "問答" })).toBeTruthy();
    expect(screen.getByText(/REC 12:46/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "会話を終了" })).toBeTruthy();
    expect(screen.getByText(/要件 8/)).toBeTruthy();
    expect(screen.getByText(/未確定 2/)).toBeTruthy();
    expect(screen.getByText(/資料 3/)).toBeTruthy();
    expect(screen.getByText(/解析中/)).toBeTruthy();
  });

  it("既定タブは会話履歴で、本文に履歴が出る（他タブ本文は出ない）", () => {
    renderShell();
    expect(screen.getByText("会話本文")).toBeTruthy();
    expect(screen.queryByText("ファイル本文")).toBeNull();
    expect(screen.queryByText("絵巻本文")).toBeNull();
    expect(screen.getByRole("tab", { name: "会話履歴" }).getAttribute("aria-selected")).toBe("true");
  });

  it("タブを切り替えると本文だけ変わり、常時UI（問いピン・下部バー）は出たまま", () => {
    renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByText("ファイル本文")).toBeTruthy();
    expect(screen.queryByText("会話本文")).toBeNull();
    expect(screen.getByText("問いピン")).toBeTruthy();
    expect(screen.getByText("下部バー")).toBeTruthy();
    expect(screen.getByText(/要件 8/)).toBeTruthy();
  });

  it("終了ボタンで onEnd が呼ばれる", () => {
    const onEnd = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("onEnd が無いときは終了ボタンを無効化する", () => {
    render(
      <ConversationShell
        mini={mini}
        tabs={{ history: <div>h</div>, files: <div>f</div>, scroll: <div>s</div> }}
        bottomBar={<div>bar</div>}
      />,
    );
    expect((screen.getByRole("button", { name: "会話を終了" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ミニ状況の『資料』タップで参考資料、『要件』タップで要件絵巻タブへ移動", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /資料/ }));
    expect(screen.getByText("ファイル本文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /要件 8/ }));
    expect(screen.getByText("絵巻本文")).toBeTruthy();
  });

  it("『未確定』タップは要件絵巻へ移動し onUnresolvedJump を発火する (#195)", () => {
    const onTabChange = vi.fn();
    const onUnresolvedJump = vi.fn();
    render(
      <ConversationShell
        mini={mini}
        tab="history"
        onTabChange={onTabChange}
        onUnresolvedJump={onUnresolvedJump}
        tabs={{ history: <div>h</div>, files: <div>f</div>, scroll: <div>s</div> }}
        bottomBar={<div>bar</div>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /未確定 2/ }));
    expect(onTabChange).toHaveBeenCalledWith("scroll");
    expect(onUnresolvedJump).toHaveBeenCalledTimes(1);
  });

  it("閲覧モード（review）では REC・終了・問いピン・下部バーを出さず、結果へ戻る導線を出す", () => {
    const onBackToResult = vi.fn();
    render(
      <ConversationShell
        mini={mini}
        elapsed="12:46"
        review
        onBackToResult={onBackToResult}
        onEnd={vi.fn()}
        tabs={{
          history: <div>会話本文</div>,
          files: <div>ファイル本文</div>,
          scroll: <div>絵巻本文</div>,
        }}
        choicePin={<div>問いピン</div>}
        bottomBar={<div>下部バー</div>}
      />,
    );
    expect(screen.queryByText(/REC/)).toBeNull();
    expect(screen.queryByRole("button", { name: "会話を終了" })).toBeNull();
    expect(screen.queryByText("問いピン")).toBeNull();
    expect(screen.queryByText("下部バー")).toBeNull();
    expect(screen.getByRole("tab", { name: "会話履歴" })).toBeTruthy();
    expect(screen.getByText("会話本文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "結果に戻る" }));
    expect(onBackToResult).toHaveBeenCalledTimes(1);
  });

  it("音声状態（voiceStatus）は上部の固定領域に表示する", () => {
    render(
      <ConversationShell
        mini={mini}
        tabs={{ history: <div>h</div>, files: <div>f</div>, scroll: <div>s</div> }}
        choicePin={<div>問いピン</div>}
        bottomBar={<div>下部バー</div>}
        voiceStatus={<div>聞き取り中インジケータ</div>}
      />,
    );
    expect(screen.getByText("聞き取り中インジケータ")).toBeTruthy();
  });

  it("ヘッダーを最小化するとミニ状況を隠し、開くと戻る（トグル）", () => {
    render(
      <ConversationShell
        mini={mini}
        tabs={{ history: <div>h</div>, files: <div>f</div>, scroll: <div>s</div> }}
        bottomBar={<div>bar</div>}
      />,
    );
    expect(screen.getByText(/要件 8/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ヘッダーを最小化" }));
    expect(screen.queryByText(/要件 8/)).toBeNull();
    expect(screen.getByRole("tab", { name: "会話履歴" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ヘッダーを開く" }));
    expect(screen.getByText(/要件 8/)).toBeTruthy();
  });

  it("『要件』タップでは onUnresolvedJump を発火しない（タブ移動のみ） (#195)", () => {
    const onUnresolvedJump = vi.fn();
    render(
      <ConversationShell
        mini={mini}
        tab="history"
        onTabChange={vi.fn()}
        onUnresolvedJump={onUnresolvedJump}
        tabs={{ history: <div>h</div>, files: <div>f</div>, scroll: <div>s</div> }}
        bottomBar={<div>bar</div>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /要件 8/ }));
    expect(onUnresolvedJump).not.toHaveBeenCalled();
  });
});
