// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  figureStateForVoiceStatus,
  resolveVoiceStatus,
  VoiceStatusIndicator,
} from "./VoiceStatusIndicator";

describe("resolveVoiceStatus（状態源を優先順位で畳む）", () => {
  it("muted は最優先（発話中・聞き取り中より上）", () => {
    expect(
      resolveVoiceStatus({ phase: "listening", micOn: true, muted: true, agentSpeaking: true }),
    ).toBe("muted");
  });

  it("非 muted でエージェント発話中なら agent-speaking（聞き取り中より上）", () => {
    expect(
      resolveVoiceStatus({ phase: "listening", micOn: true, muted: false, agentSpeaking: true }),
    ).toBe("agent-speaking");
  });

  it("listening かつマイク入力中・非発話なら listening", () => {
    expect(
      resolveVoiceStatus({ phase: "listening", micOn: true, muted: false, agentSpeaking: false }),
    ).toBe("listening");
  });

  it("listening でもマイク OFF なら idle（聞き取れない）", () => {
    expect(
      resolveVoiceStatus({ phase: "listening", micOn: false, muted: false }),
    ).toBe("idle");
  });

  it("listening 以外のフェーズは idle", () => {
    expect(
      resolveVoiceStatus({ phase: "deliberating", micOn: true, muted: false }),
    ).toBe("idle");
  });
});

describe("figureStateForVoiceStatus（音声状態→棒人間の配線 / ADR-0033 §6）", () => {
  it("聞き取り中はサンバさんが耳を澄ます（listening）", () => {
    expect(figureStateForVoiceStatus("listening")).toBe("listening");
  });

  it("発話中・消音中・待機中は figure を出さない（1画面1体・過剰演出回避）", () => {
    expect(figureStateForVoiceStatus("agent-speaking")).toBeNull();
    expect(figureStateForVoiceStatus("muted")).toBeNull();
    expect(figureStateForVoiceStatus("idle")).toBeNull();
  });
});

describe("VoiceStatusIndicator（ラベル＋アイコン・色非依存）", () => {
  afterEach(() => cleanup());

  it("聞き取り中は装飾の棒人間を添える（.sanba-fig-joint 有り）", () => {
    const { container } = render(
      <VoiceStatusIndicator phase="listening" micOn muted={false} agentSpeaking={false} />,
    );
    expect(container.querySelector(".sanba-fig-joint")).not.toBeNull();
  });

  it("待機中は棒人間を添えない（figure 無し）", () => {
    const { container } = render(
      <VoiceStatusIndicator phase="idle" micOn={false} muted={false} />,
    );
    expect(container.querySelector(".sanba-fig-joint")).toBeNull();
  });

  it("エージェント発話中は「発話中／読み上げ中」を表示する（isSpeaking）", () => {
    render(<VoiceStatusIndicator phase="listening" micOn muted={false} agentSpeaking />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-status")).toBe("agent-speaking");
    expect(el.textContent).toContain("発話中／読み上げ中");
    expect(el.getAttribute("aria-label")).toBe("音声状態: 発話中／読み上げ中");
  });

  it("リスニング中は「聞き取り中」を表示する", () => {
    render(<VoiceStatusIndicator phase="listening" micOn muted={false} agentSpeaking={false} />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-status")).toBe("listening");
    expect(el.textContent).toContain("聞き取り中");
  });

  it("消音時は「スピーカー消音中」を表示する（最優先）", () => {
    render(<VoiceStatusIndicator phase="listening" micOn muted agentSpeaking />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-status")).toBe("muted");
    expect(el.textContent).toContain("スピーカー消音中");
  });

  it("該当なしは「待機中」を表示する", () => {
    render(<VoiceStatusIndicator phase="idle" micOn={false} muted={false} />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-status")).toBe("idle");
    expect(el.textContent).toContain("待機中");
  });

  it("状態変化を読み上げる aria-live を持つ", () => {
    render(<VoiceStatusIndicator phase="listening" micOn muted={false} />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
});
