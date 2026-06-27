// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 入口フロー（01 ホーム → 02 準備 → 開始）の状態遷移を検証する（#140 / ADR-0017）。
// 重い依存（LiveKit / SessionView）と auth / api はモックして、ページ固有のロジック
// （ステップ遷移・役割既定・同意ゲート・二重送信防止・開始呼び出し）に集中する。

const authState = {
  credential: null as string | null,
  profile: null as { name?: string } | null,
  loggedIn: false,
  ready: true,
  devMode: true,
  buttonRef: { current: null },
  devSignIn: vi.fn(),
  signOut: vi.fn(),
  resetButton: vi.fn(),
};
vi.mock("../lib/auth", () => ({ useGoogleAuth: () => authState }));

// 厳密な認証ゲート（RequireAuth）のリダイレクト先を検証するため useRouter をモック。
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const createSession = vi.fn(async (..._a: unknown[]) => ({
  session_id: "s1",
  invites: { pm: "inv-pm" },
}));
const joinSession = vi.fn(async (..._a: unknown[]) => ({
  token: "t",
  livekit_url: "ws://x",
  session_id: "s1",
  identity: "id",
  session_token: "st",
}));
const addSessionContext = vi.fn(async (..._a: unknown[]) => ({ indexed_chunks: 0 }));
vi.mock("../lib/api", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  joinSession: (...a: unknown[]) => joinSession(...a),
  addSessionContext: (...a: unknown[]) => addSessionContext(...a),
}));

// 接続後ブランチに入っても落ちないよう、LiveKit / SessionView は素通しにする。
vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RoomAudioRenderer: () => null,
  StartAudio: () => null,
}));
vi.mock("../components/SessionView", () => ({ SessionView: () => <div>session-view</div> }));

import Home from "./page";

describe("入口フロー（#140）", () => {
  beforeEach(() => {
    authState.loggedIn = false;
    authState.credential = null;
    authState.profile = null;
    authState.ready = true;
    authState.devMode = true;
    replace.mockClear();
    createSession.mockClear();
    joinSession.mockClear();
    addSessionContext.mockClear();
  });
  afterEach(() => cleanup());

  it("real モードで未ログインなら /login?next=/ へリダイレクトしホームを描画しない", () => {
    authState.devMode = false;
    authState.ready = true;
    authState.loggedIn = false;
    render(<Home />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/")}`);
    expect(screen.queryByText("会議の前に、五分の問答を")).toBeNull();
  });

  it("real モードで認証解決前（ready=false）はリダイレクトせず何も描かない", () => {
    authState.devMode = false;
    authState.ready = false;
    authState.loggedIn = false;
    render(<Home />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("会議の前に、五分の問答を")).toBeNull();
  });

  it("01 ホームはヒーローと一語 CTA を出し、実績カードを持たない", () => {
    render(<Home />);
    expect(screen.getByText("会議の前に、五分の問答を")).toBeTruthy();
    expect(screen.getByText("＋ 壁打ちを始める")).toBeTruthy();
    expect(screen.queryByText(/取り上げた抜け・矛盾/)).toBeNull();
  });

  it("01 ホームはヒーロー下に「過去の要件を見る」見出しと空状態の文言を出す（#215）", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "過去の要件を見る" })).toBeTruthy();
    // データ取得 API は別途のため、現状は空状態。遷移リンクは出さない。
    expect(screen.getByText(/過去の要件はまだございません/)).toBeTruthy();
  });

  it("CTA で 02 準備へ遷移し、役割の既定が企画(PdM)", () => {
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /企画/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "エンジニア" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("未ログインでは開始が無効でログイン導線を示す", () => {
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const cta = screen.getByRole("button", { name: "インタビューを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("ログインへ").getAttribute("href")).toBe("/login");
  });

  it("ログイン済みでも同意 OFF の間は開始が無効で理由を示す", () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const cta = screen.getByRole("button", { name: "インタビューを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("録音と AI 処理への同意が必要です。")).toBeTruthy();
  });

  it("同意 ON で開始でき、選択役割と同意が createSession に渡る", async () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    fireEvent.click(screen.getByRole("radio", { name: "エンジニア" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "インタビューを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][0]).toEqual(["engineer"]);
    expect(createSession.mock.calls[0][1]).toBe(true);
    // 開始後は 03 会話開始（開始前サマリ）へ。接続/許可はここから先（ConversationStart）。
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
  });

  it("開始処理中は二重送信できない", async () => {
    authState.loggedIn = true;
    let release: (v: Awaited<ReturnType<typeof createSession>>) => void = () => {};
    createSession.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    fireEvent.click(screen.getByRole("checkbox"));
    const cta = screen.getByRole("button", { name: "インタビューを始める" });
    fireEvent.click(cta);
    fireEvent.click(cta); // 連打
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("準備しています…")).toBeTruthy();
    await act(async () => {
      release({ session_id: "s1", invites: { pm: "inv-pm" } });
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
