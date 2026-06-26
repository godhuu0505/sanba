// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionState } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectingOverlay, StartFailed, StartIntro } from "./ConversationStart";

// 03 会話開始の純プレゼン（LiveKit 非依存）。開始前サマリ・接続中ステップ・失敗系の3導線。
// 仕様: docs/design/screens/03-conversation-start.md。

describe("StartIntro（03-0 開始前）", () => {
  afterEach(() => cleanup());

  it("ゴール/役割のサマリを引き継ぎ、マイク使用の理由を提示する", () => {
    render(
      <StartIntro
        goal="検索機能のリニューアル"
        roleLabel="企画(PdM)"
        onStartVoice={vi.fn()}
        onStartText={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("検索機能のリニューアル")).toBeTruthy();
    expect(screen.getByText("企画(PdM)")).toBeTruthy();
    // OS プロンプト前の理由提示（03 AC）。
    expect(screen.getByText(/マイクを使用します/)).toBeTruthy();
  });

  it("音声開始・テキスト開始がそれぞれ配線される", () => {
    const onStartVoice = vi.fn();
    const onStartText = vi.fn();
    render(
      <StartIntro
        goal=""
        roleLabel="顧客"
        onStartVoice={onStartVoice}
        onStartText={onStartText}
        onBack={vi.fn()}
      />,
    );
    // ゴール未入力は明示する。
    expect(screen.getByText("（未入力）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "音声で会話を始める" }));
    expect(onStartVoice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "音声を使わずテキストで進める" }));
    expect(onStartText).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectingOverlay（03-1 接続中）", () => {
  afterEach(() => cleanup());

  it("接続中はキャンセルでき、再接続中は文言が変わる", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConnectingOverlay state={ConnectionState.Connecting} onCancel={onCancel} />,
    );
    expect(screen.getByText("繋いでおります…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "接続を中断して戻る" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<ConnectingOverlay state={ConnectionState.Reconnecting} onCancel={onCancel} />);
    expect(screen.getByText("繋ぎ直しております…")).toBeTruthy();
  });
});

describe("StartFailed（03-3 失敗系）", () => {
  afterEach(() => cleanup());

  it("マイク拒否は許可導線＋再試行＋テキスト代替の3導線を出す", () => {
    const onRetry = vi.fn();
    const onText = vi.fn();
    render(<StartFailed kind="mic" onRetry={onRetry} onText={onText} onBack={vi.fn()} />);
    expect(screen.getByText("声を捉えられませなんだ")).toBeTruthy();
    expect(screen.getByText(/ブラウザ設定の「マイク」を許可/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "もう一度接続を試す" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "音声を使わずテキストで続ける" }));
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it("接続失敗はネットワーク原因を提示する", () => {
    render(<StartFailed kind="connect" onRetry={vi.fn()} onText={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("繋ぐことが叶いませなんだ")).toBeTruthy();
    expect(screen.getByText(/ネットワークが不安定/)).toBeTruthy();
  });
});
