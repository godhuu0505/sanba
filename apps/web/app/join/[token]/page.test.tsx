// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

// 深掘りリンク入場（FR-1.6）:
// - 表示だけでは POST しない（use_count を消費しない）— 最重要 AC
// - 未ログインは /login?next=/join/{token} へ
// - 同意なしで開始不可・403 reason 別の明確なエラー画面・成功時は invite が joinSession へ渡り会話へ

const authState = {
  credential: "id-token",
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
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    joinProduct: (...args: unknown[]) => joinProduct(...args),
    joinSession: (...args: unknown[]) => joinSession(...args),
  };
});

// LiveKit 接続を持つ ConversationStart は挙動テストの関心外なのでマーカーに差し替える。
vi.mock("@/components/ConversationStart", () => ({
  ConversationStart: ({ conn, goal, roleLabel }: { conn: { session_id: string }; goal: string; roleLabel: string }) => (
    <div data-testid="conversation-start">
      {conn.session_id} / {goal} / {roleLabel}
    </div>
  ),
}));

import JoinPage, { classifyJoinError } from "./page";

function joined(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    invite: "role-invite.sig",
    product_id: "prod-1",
    product_name: "経費精算アプリ",
    interview_mode: "end_user",
    ...overrides,
  };
}

async function startWithConsent() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "深掘りを開始する" }));
}

describe("深掘りリンク入場画面（ADR-0031 / FR-1.6）", () => {
  beforeEach(() => {
    authState.loggedIn = true;
    authState.ready = true;
    replace.mockClear();
    push.mockClear();
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

  it("未ログインなら /login?next=/join/{token} へリダイレクトする", () => {
    authState.loggedIn = false;
    render(<JoinPage />);
    expect(replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/join/tok.sig")}`,
    );
    expect(joinProduct).not.toHaveBeenCalled();
  });

  it("表示・リロードだけでは join を呼ばない（use_count を消費しない）", () => {
    render(<JoinPage />);
    expect(screen.getByText("深掘りリンクから参加します")).toBeTruthy();
    expect(joinProduct).not.toHaveBeenCalled();
    expect(joinSession).not.toHaveBeenCalled();
  });

  it("同意チェックなしでは開始ボタンが無効で join を呼べない", () => {
    render(<JoinPage />);
    const button = screen.getByRole("button", { name: "深掘りを開始する" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(joinProduct).not.toHaveBeenCalled();
  });

  it("開始すると join → joinSession（invite 引き渡し）→ 会話コンポーネントへ", async () => {
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
    // product_name と interview_mode（end_user → 顧客）がサマリに引き継がれる。
    expect(screen.getByTestId("conversation-start").textContent).toContain("経費精算アプリ");
    expect(screen.getByTestId("conversation-start").textContent).toContain("顧客");
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
      // 死リンクは開始ボタンを出さない（再タップで再消費させない）。
      expect(screen.queryByRole("button", { name: "深掘りを開始する" })).toBeNull();
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
    // 429 は一時的な失敗なので開始 UI を残す（手動の再試行のみ許す）。
    expect(screen.getByRole("button", { name: "深掘りを開始する" })).toBeTruthy();
    expect(joinProduct).toHaveBeenCalledTimes(2);
  });

  it("joinProduct 成功後に joinSession が失敗した場合、リトライで joinProduct を再消費しない", async () => {
    joinSession.mockRejectedValueOnce(new ApiError(429, "rate limit exceeded"));
    render(<JoinPage />);
    await startWithConsent();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(joinProduct).toHaveBeenCalledTimes(1);

    // リトライ: joinProduct は呼ばず joinSession だけ再実行する（use_count を守る）。
    fireEvent.click(screen.getByRole("button", { name: "深掘りを開始する" }));
    await waitFor(() => expect(screen.getByTestId("conversation-start")).toBeTruthy());
    expect(joinProduct).toHaveBeenCalledTimes(1); // 増えていない（再消費なし）
    expect(joinSession).toHaveBeenCalledTimes(2);
  });

  it("classifyJoinError は未知のエラーを一時エラーに平す", () => {
    expect(classifyJoinError(new Error("network")).retryable).toBe(true);
    expect(classifyJoinError(new ApiError(403, "invalid invite link: bad signature")).retryable).toBe(
      false,
    );
  });
});
