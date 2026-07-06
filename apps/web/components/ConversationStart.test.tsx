// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionState } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectingOverlay, MicPermissionModal, StartFailed, StartIntro } from "./ConversationStart";

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
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("検索機能のリニューアル")).toBeTruthy();
    expect(screen.getByText("企画(PdM)")).toBeTruthy();
    // OS プロンプト前の理由提示（03 AC）。
    expect(screen.getByText(/マイクを使用します/)).toBeTruthy();
  });

  it("参考資料は未添付なら「会話中に追加できます」、添付ありは名前＋件数を出す（監査 B-2 #11）", () => {
    const { rerender } = render(
      <StartIntro goal="" roleLabel="顧客" onStartVoice={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText("会話中に追加できます")).toBeTruthy();

    rerender(
      <StartIntro
        goal=""
        roleLabel="顧客"
        materialNames={["PRD.png", "demo.mp4"]}
        onStartVoice={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByText("会話中に追加できます")).toBeNull();
    expect(screen.getByText(/PRD\.png ・ 他1件/)).toBeTruthy();
    expect(screen.getByText(/（計2件）/)).toBeTruthy();
  });

  it("投入失敗があれば件数を注意書きで出す（Codex P2）", () => {
    render(
      <StartIntro
        goal=""
        roleLabel="顧客"
        materialNames={["ok.png"]}
        materialFailedCount={2}
        onStartVoice={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/ok\.png/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("2件は投入できませんでした");
  });

  it("音声開始が配線され、テキスト開始の導線は出さない", () => {
    const onStartVoice = vi.fn();
    render(<StartIntro goal="" roleLabel="顧客" onStartVoice={onStartVoice} onBack={vi.fn()} />);
    // ゴール未入力は明示する。
    expect(screen.getByText("（未入力）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "音声で会話を始める" }));
    expect(onStartVoice).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "音声を使わずテキストで進める" })).toBeNull();
  });
});

describe("MicPermissionModal（03-2 録音許可）", () => {
  afterEach(() => cleanup());

  it("OS プロンプト前に理由を提示し、許可を配線する（テキスト代替は出さない）", () => {
    const onAllow = vi.fn();
    render(<MicPermissionModal onAllow={onAllow} onDismiss={vi.fn()} />);
    // 暗幕付きの dialog で理由提示（03 AC）。
    expect(screen.getByRole("dialog", { name: "マイクの使用許可" })).toBeTruthy();
    expect(screen.getByText("声を聞かせてくださいませ")).toBeTruthy();
    expect(screen.getByText(/端末のマイクを用います/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "マイクの使用を許可する" }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "音声を使わずテキストで進める" })).toBeNull();
  });

  it("暗幕タップで閉じる", () => {
    const onDismiss = vi.fn();
    render(<MicPermissionModal onAllow={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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

  it("マイク拒否は設定導線＋再試行を出す（テキスト代替は出さない）", () => {
    const onRetry = vi.fn();
    render(<StartFailed kind="mic" onRetry={onRetry} onBack={vi.fn()} />);
    expect(screen.getByText("声を捉えられませなんだ")).toBeTruthy();
    // 設定導線は第一 CTA のボタン（静的ヒント文ではない）。
    expect(screen.getByRole("button", { name: "ブラウザのマイク設定を開く手順を表示" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "もう一度接続を試す" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "音声を使わずテキストで続ける" })).toBeNull();
  });

  it("設定ボタン押下で手順ガイドを展開する（aria-expanded 切替）", () => {
    render(<StartFailed kind="mic" onRetry={vi.fn()} onBack={vi.fn()} />);
    const settings = screen.getByRole("button", { name: "ブラウザのマイク設定を開く手順を表示" });
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "マイク許可の手順" })).toBeNull();
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "マイク許可の手順" })).toBeTruthy();
    expect(screen.getByText(/「マイク」を「許可」に変更/)).toBeTruthy();
  });

  it("接続失敗はネットワーク原因を提示し、設定導線は出さない", () => {
    render(<StartFailed kind="connect" onRetry={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("繋ぐことが叶いませなんだ")).toBeTruthy();
    expect(screen.getByText(/ネットワークが不安定/)).toBeTruthy();
    // 接続失敗では「設定を開く」は無意味なので出さない。
    expect(screen.queryByRole("button", { name: "ブラウザのマイク設定を開く手順を表示" })).toBeNull();
  });
});
