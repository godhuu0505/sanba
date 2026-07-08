// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const authState = {
  credential: "id-token" as string | null,
  profile: { name: "話し手" } as { name?: string } | null,
  loggedIn: true,
  ready: true,
  devMode: false,
  buttonRef: { current: null },
  devSignIn: vi.fn(),
  signOut: vi.fn(),
  resetButton: vi.fn(),
};
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
  useParams: () => ({ token: "tok.sig" }),
}));

const joinProduct = vi.fn();
const joinSession = vi.fn();
const sendTelemetry = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    joinProduct: (...args: unknown[]) => joinProduct(...args),
    joinSession: (...args: unknown[]) => joinSession(...args),
    sendTelemetry: (...args: unknown[]) => sendTelemetry(...args),
  };
});

vi.mock("@/components/ConversationStart", () => ({
  ConversationStart: ({
    conn,
    goal,
    roleLabel,
    readOnly,
    onCancel,
  }: {
    conn: { session_id: string };
    goal: string;
    roleLabel: string;
    readOnly?: boolean;
    onCancel: () => void;
  }) => (
    <div data-testid="conversation-start" data-readonly={readOnly ? "1" : "0"}>
      {conn.session_id} / {goal} / {roleLabel}
      <button type="button" onClick={onCancel}>
        中断
      </button>
    </div>
  ),
}));

import JoinPage, { classifyJoinError } from "./page";

const GUEST_JOIN = {
  token: "lk-guest",
  livekit_url: "ws://x",
  session_id: "sess-9",
  identity: "guest:abc123",
  session_token: "guest-st",
};

function joined(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    invite: "role-invite.sig",
    product_id: "prod-1",
    product_name: "経費精算アプリ",
    interview_mode: "end_user",
    join: null,
    ...overrides,
  };
}

async function startWithConsent() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "会話を始める" }));
}

describe("深掘りリンク入場画面（ADR-0031 / ADR-0032 / FR-1.6 / FR-2.1）", () => {
  beforeEach(() => {
    authState.credential = "id-token";
    authState.loggedIn = true;
    authState.ready = true;
    replace.mockClear();
    push.mockClear();
    sendTelemetry.mockClear();
    joinProduct.mockReset().mockResolvedValue(joined());
    joinSession.mockReset().mockResolvedValue({
      token: "lk",
      livekit_url: "ws://x",
      session_id: "sess-1",
      identity: "customer-1",
      session_token: "st",
    });
  });
  afterEach(() => cleanup());

  it("未ログインでもログインへ飛ばさず、同意ゲートを表示する（FR-2.1）", () => {
    authState.loggedIn = false;
    authState.credential = null;
    render(<JoinPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("リンクから会話に参加します")).toBeTruthy();
    expect(joinProduct).not.toHaveBeenCalled();
  });

  it("同意文言に保持期間（30 日）と発行者側に残る旨を明示する（FR-2.2 / FR-2.7）", () => {
    render(<JoinPage />);
    const gate = screen.getByText("はじめる前にご確認ください").parentElement;
    expect(gate?.textContent).toContain("30 日たつと自動で削除");
    expect(gate?.textContent).toContain("発行者の手元には残ります");
    expect(gate?.textContent).toContain("録音");
  });

  it("表示・リロードだけでは join を呼ばない（use_count を消費しない）", () => {
    render(<JoinPage />);
    expect(joinProduct).not.toHaveBeenCalled();
    expect(joinSession).not.toHaveBeenCalled();
  });

  it("同意チェックなしでは開始ボタンが無効で join を呼べない", () => {
    render(<JoinPage />);
    const button = screen.getByRole("button", { name: "会話を始める" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(joinProduct).not.toHaveBeenCalled();
  });

  it("認証解決前（ready=false）は開始できない（GIS 復元前の誤ゲスト入場を防ぐ）", () => {
    authState.ready = false;
    authState.loggedIn = false;
    authState.credential = null;
    render(<JoinPage />);
    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: "会話を始める" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("ログイン済み: join → joinSession（invite 引き渡し）→ 会話コンポーネントへ", async () => {
    render(<JoinPage />);
    await startWithConsent();
    await waitFor(() => expect(screen.getByTestId("conversation-start")).toBeTruthy());
    expect(joinProduct).toHaveBeenCalledTimes(1);
    expect(joinProduct).toHaveBeenCalledWith("tok.sig", true, "id-token");
    expect(joinSession).toHaveBeenCalledWith({
      invite: "role-invite.sig",
      participantName: "話し手",
      idToken: "id-token",
    });
    expect(screen.getByTestId("conversation-start").textContent).toContain("経費精算アプリ");
    expect(screen.getByTestId("conversation-start").textContent).toContain("利用者");
    expect(screen.getByTestId("conversation-start").dataset.readonly).toBe("0");
  });

  it("ゲスト: join 直返しでそのまま接続し、joinSession を呼ばない（issue #319）", async () => {
    authState.loggedIn = false;
    authState.credential = null;
    joinProduct.mockResolvedValue(joined({ invite: null, join: GUEST_JOIN, session_id: "sess-9" }));
    render(<JoinPage />);
    await startWithConsent();
    await waitFor(() => expect(screen.getByTestId("conversation-start")).toBeTruthy());
    expect(joinProduct).toHaveBeenCalledWith("tok.sig", true, null);
    expect(joinSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("conversation-start").dataset.readonly).toBe("1");
    expect(screen.getByTestId("conversation-start").textContent).toContain("sess-9");
  });

  it("ゲストの離脱（中断）は join.abort telemetry を送る", async () => {
    authState.loggedIn = false;
    authState.credential = null;
    joinProduct.mockResolvedValue(joined({ invite: null, join: GUEST_JOIN, session_id: "sess-9" }));
    render(<JoinPage />);
    await startWithConsent();
    await waitFor(() => expect(screen.getByTestId("conversation-start")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(sendTelemetry).toHaveBeenCalledWith(
      "sess-9",
      "join.abort",
      { result: "aborted" },
      "guest-st",
    );
    expect(push).toHaveBeenCalledWith("/");
  });

  it("401（flag off / developer リンク）はログイン誘導を出す", async () => {
    authState.loggedIn = false;
    authState.credential = null;
    joinProduct.mockRejectedValueOnce(new ApiError(401, "authentication required"));
    render(<JoinPage />);
    await startWithConsent();
    expect(await screen.findByText("参加にはログインが必要です")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "会話を始める" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ログインして参加する" }));
    expect(push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/join/tok.sig")}`);
  });

  it("403 は reason 別の死リンク画面になり、開始 UI を出さない（再試行させない）", async () => {
    for (const [reason, title] of [
      ["expired", "リンクの期限が切れています"],
      ["revoked", "リンクは無効化されています"],
      ["exhausted", "リンクの利用上限に達しています"],
    ] as const) {
      joinProduct.mockRejectedValueOnce(new ApiError(403, `invite not usable: ${reason}`));
      render(<JoinPage />);
      await startWithConsent();
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "会話を始める" })).toBeNull();
      cleanup();
    }
  });

  it("404 はリンク消滅、429 は一時エラー（開始 UI を残す）", async () => {
    joinProduct.mockRejectedValueOnce(new ApiError(404, "invite not found"));
    render(<JoinPage />);
    await startWithConsent();
    expect(await screen.findByText("リンクが見つかりません")).toBeTruthy();
    cleanup();

    joinProduct.mockRejectedValueOnce(new ApiError(429, "rate limit exceeded"));
    render(<JoinPage />);
    await startWithConsent();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "会話を始める" })).toBeTruthy();
    expect(joinProduct).toHaveBeenCalledTimes(2);
  });

  it("joinProduct 成功後に joinSession が失敗した場合、リトライで joinProduct を再消費しない", async () => {
    joinSession.mockRejectedValueOnce(new ApiError(429, "rate limit exceeded"));
    render(<JoinPage />);
    await startWithConsent();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(joinProduct).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "会話を始める" }));
    await waitFor(() => expect(screen.getByTestId("conversation-start")).toBeTruthy());
    expect(joinProduct).toHaveBeenCalledTimes(1);
    expect(joinSession).toHaveBeenCalledTimes(2);
  });

  it("classifyJoinError は未知のエラーを一時エラーに平す", () => {
    expect(classifyJoinError(new Error("network")).retryable).toBe(true);
    expect(classifyJoinError(new ApiError(403, "invalid invite link: bad signature")).retryable).toBe(
      false,
    );
    expect(classifyJoinError(new ApiError(401, "authentication required")).loginRequired).toBe(true);
  });
});
