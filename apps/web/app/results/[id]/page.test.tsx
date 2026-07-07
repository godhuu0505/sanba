// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 過去要件の絵巻閲覧画面（/results/[id]）。ホーム履歴からの遷移先で、要件絵巻だけを閲覧する。
// 認証ゲート・本人限定 404・絵巻本体（MoSCoW 区分）・空状態を検証する。

const authState = {
  credential: "id-token" as string | null,
  profile: null as { name?: string } | null,
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
  useParams: () => ({ id: "sess-1" }),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  fetchMySessionRequirements: vi.fn(),
}));

import { ApiError, fetchMySessionRequirements, type MySessionRequirements } from "@/lib/api";
import PastRequirementsPage from "./page";

const SCROLL: MySessionRequirements = {
  id: "sess-1",
  title: "新機能要件定義",
  created_at: "2024-06-20T10:00:00Z",
  finalized: true,
  items: [
    {
      id: "r1",
      statement: "キーワード検索を新設する",
      category: "functional",
      priority: "must",
      confidence: 0.9,
      source_speaker: "顧客",
      citations: [],
      status: "confirmed",
    },
    {
      id: "r2",
      statement: "検索結果は 1 秒以内に返す",
      category: "non_functional",
      priority: "should",
      confidence: 0.6,
      source_speaker: "エンジニア",
      citations: [],
      status: "confirmed",
    },
  ],
};

describe("過去要件の絵巻閲覧画面（/results/[id]）", () => {
  beforeEach(() => {
    authState.loggedIn = true;
    authState.ready = true;
    authState.devMode = false;
    replace.mockClear();
    push.mockClear();
    authState.signOut.mockClear();
    vi.mocked(fetchMySessionRequirements).mockReset().mockResolvedValue(SCROLL);
  });
  afterEach(() => cleanup());

  it("real モードで未ログインなら /login?next=/results/{id} へリダイレクトし本文を描画しない", () => {
    authState.loggedIn = false;
    render(<PastRequirementsPage />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/results/sess-1")}`);
    expect(screen.queryByText("要件絵巻")).toBeNull();
  });

  it("標題・日付・確定状態と、MoSCoW 区分の要件絵巻だけを出す（管理操作は無い）", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    expect(screen.getByText("要件絵巻")).toBeTruthy();
    expect(screen.getByText(/2024\/06\/20/)).toBeTruthy();
    expect(screen.getByText(/確定済み/)).toBeTruthy();
    // MoSCoW 区分（必ず/なるべく）に分かれて要件が並ぶ。
    expect(screen.getByText("キーワード検索を新設する")).toBeTruthy();
    expect(screen.getByText("検索結果は 1 秒以内に返す")).toBeTruthy();
    // 絵巻の閲覧のみ: 承認/却下/編集の操作は出さない。
    expect(screen.queryByText(/認める|退ける|改める|検める/)).toBeNull();
  });

  it("要件 0 件なら空状態の文言を出す", async () => {
    vi.mocked(fetchMySessionRequirements).mockResolvedValue({ ...SCROLL, items: [] });
    render(<PastRequirementsPage />);
    await waitFor(() =>
      expect(screen.getByText(/このセッションの要件はまだ生まれておりませぬ/)).toBeTruthy(),
    );
  });

  it("401（idToken 期限切れ）は再認証導線を出し、押下で signOut して credential を clear する", async () => {
    // authGate はメモリ上の loggedIn しか見ないため、期限切れ token では API 401 でここに到達する。
    vi.mocked(fetchMySessionRequirements).mockRejectedValue(new ApiError(401, "unauthorized"));
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("ログインへ")).toBeTruthy());
    fireEvent.click(screen.getByText("ログインへ"));
    // 無効トークンでの再試行ループに入らず、authGate 経由で /login?next= へ送る。
    expect(authState.signOut).toHaveBeenCalledTimes(1);
  });

  it("404（非所有・不存在）は「見つからない」表示に落とす", async () => {
    vi.mocked(fetchMySessionRequirements).mockRejectedValue(new ApiError(404, "not found"));
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText(/この要件は見つかりませんでした/)).toBeTruthy());
  });

  it("その他の失敗は再試行導線を出し、押下で取り直す", async () => {
    vi.mocked(fetchMySessionRequirements)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(SCROLL);
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("再び試みる")).toBeTruthy());
    fireEvent.click(screen.getByText("再び試みる"));
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
  });

  it("戻るは過去の要件一覧 /results へ送る", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(push).toHaveBeenCalledWith("/results");
  });
});
