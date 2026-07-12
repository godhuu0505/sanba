// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/auth", () => ({
  useAuth: () => authState,
  useAuthOptional: () => authState,
}));

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
  fetchMySessionResultDocument: vi.fn(),
  fetchMySessionTranscript: vi.fn(),
  fetchMyExportEligibility: vi.fn(),
  exportMyRequirements: vi.fn(),
}));

import {
  ApiError,
  exportMyRequirements,
  fetchMyExportEligibility,
  fetchMySessionRequirements,
  fetchMySessionTranscript,
  type MySessionRequirements,
  type SessionTranscript,
} from "@/lib/api";
import PastRequirementsPage from "./page";

const SCROLL: MySessionRequirements = {
  id: "sess-1",
  title: "新機能要件定義",
  created_at: "2024-06-20T10:00:00Z",
  finalized: true,
  goal: "検索機能を改善する",
  goal_detail: "現状は検索が遅い。まず商品検索だけ対象にしたい。",
  materials: [
    { id: "m1", name: "画面設計.pdf", kind: "doc", status: "done" },
    { id: "m2", name: "現行画面.png", kind: "image", status: "done" },
  ],
  open_inquiries: [
    { id: "n1", kind: "gap", text: "検索対象に管理画面を含めるか未確認" },
  ],
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

const TRANSCRIPT: SessionTranscript = {
  id: "sess-1",
  utterances: [
    { speaker: "SANBA", text: "何を規矩としましょう", ts: "2024-06-20T10:00:00Z" },
    { speaker: "participant", text: "価格順で進めたい", ts: "2024-06-20T10:00:05Z" },
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
    vi.mocked(fetchMySessionTranscript).mockReset().mockResolvedValue(TRANSCRIPT);
    vi.mocked(fetchMyExportEligibility)
      .mockReset()
      .mockResolvedValue({ can_export: false, reason: "github not linked" });
    vi.mocked(exportMyRequirements).mockReset();
  });
  afterEach(() => cleanup());

  it("real モードで未ログインなら /login?next=/results/{id} へリダイレクトし本文を描画しない", () => {
    authState.loggedIn = false;
    render(<PastRequirementsPage />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/results/sess-1")}`);
    expect(screen.queryByText("要件一覧")).toBeNull();
  });

  it("標題・日付・確定状態と、MoSCoW 区分の要件一覧だけを出す（管理操作は無い）", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    expect(screen.getByText("要件一覧")).toBeTruthy();
    expect(screen.getByText(/2024\/06\/20/)).toBeTruthy();
    expect(screen.getByText(/確定済み/)).toBeTruthy();
    expect(screen.getByText("キーワード検索を新設する")).toBeTruthy();
    expect(screen.getByText("検索結果は 1 秒以内に返す")).toBeTruthy();
    expect(screen.queryByText(/認める|退ける|改める|検める/)).toBeNull();
  });

  it("ゴールはテキスト表示、ゴール詳細と参考資料は畳んだトグルで上部に出す", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    expect(screen.getByText("ゴール")).toBeTruthy();
    expect(screen.getByText("検索機能を改善する")).toBeTruthy();

    const detailToggle = screen.getByText("ゴールの詳細");
    expect((detailToggle.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(detailToggle);
    expect(screen.getByText(/現状は検索が遅い/)).toBeTruthy();

    const materialsToggle = screen.getByText("参考資料（2件）");
    expect((materialsToggle.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(materialsToggle);
    expect(screen.getByText("画面設計.pdf")).toBeTruthy();
    expect(screen.getByText("現行画面.png")).toBeTruthy();
  });

  it("goal 未入力ならゴール・詳細・参考資料の各セクションを出さない", async () => {
    vi.mocked(fetchMySessionRequirements).mockResolvedValue({
      ...SCROLL,
      goal: null,
      goal_detail: null,
      materials: [],
    });
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    expect(screen.queryByText("ゴール")).toBeNull();
    expect(screen.queryByText("ゴールの詳細")).toBeNull();
    expect(screen.queryByText(/参考資料（/)).toBeNull();
  });

  it("未確認事項は畳んだトグルで件数を出し、展開で内容を出す", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    const toggle = screen.getByText("未確認事項（1件）");
    expect((toggle.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByText(/検索対象に管理画面を含めるか未確認/)).toBeTruthy();
  });

  it("未確認事項 0 件でもトグルを出し、展開で空状態の文言を出す", async () => {
    vi.mocked(fetchMySessionRequirements).mockResolvedValue({
      ...SCROLL,
      open_inquiries: [],
    });
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    fireEvent.click(screen.getByText("未確認事項（0件）"));
    expect(screen.getByText(/未確認の事項はありません/)).toBeTruthy();
  });

  it("要件 0 件なら空状態の文言を出す", async () => {
    vi.mocked(fetchMySessionRequirements).mockResolvedValue({ ...SCROLL, items: [] });
    render(<PastRequirementsPage />);
    await waitFor(() =>
      expect(screen.getByText(/この会話の要件はまだありません/)).toBeTruthy(),
    );
  });

  it("401（idToken 期限切れ）は再認証導線を出し、押下で signOut して credential を clear する", async () => {
    vi.mocked(fetchMySessionRequirements).mockRejectedValue(new ApiError(401, "unauthorized"));
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("ログインへ")).toBeTruthy());
    fireEvent.click(screen.getByText("ログインへ"));
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
    await waitFor(() => expect(screen.getByText("もう一度試す")).toBeTruthy());
    fireEvent.click(screen.getByText("もう一度試す"));
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
  });

  it("戻るは過去の要件一覧 /results へ送る", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(push).toHaveBeenCalledWith("/results");
  });

  it("repo 権限が無いと Issue 作成ボタンを無効化し手動起票を案内する（ADR-0053）", async () => {
    vi.mocked(fetchMyExportEligibility).mockResolvedValue({
      can_export: false,
      reason: "no repo access",
    });
    render(<PastRequirementsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Issue を作成" })).toBeTruthy(),
    );
    const btn = screen.getByRole("button", { name: "Issue を作成" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/対象リポジトリへの権限がありません/)).toBeTruthy();
    expect(screen.getByText(/Markdown をコピー/)).toBeTruthy();
  });

  it("権限があれば Issue 作成ボタンが活性で、押下で起票し結果リンクを出す（ADR-0053）", async () => {
    vi.mocked(fetchMyExportEligibility).mockResolvedValue({ can_export: true, repo: "o/r" });
    vi.mocked(exportMyRequirements).mockResolvedValue({
      exported: true,
      issue_url: "https://github.com/o/r/issues/1",
      count: 2,
    });
    render(<PastRequirementsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Issue を作成" })).toBeTruthy(),
    );
    const btn = screen.getByRole("button", { name: "Issue を作成" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /起票した Issue を開く/ })).toBeTruthy(),
    );
    expect(vi.mocked(exportMyRequirements)).toHaveBeenCalledWith("sess-1", "id-token");
  });

  it("会話ログは既定で畳まれ、展開して初めて取得し双方向のテキストで表示する", async () => {
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    expect(vi.mocked(fetchMySessionTranscript)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("会話ログ"));
    await waitFor(() =>
      expect(vi.mocked(fetchMySessionTranscript)).toHaveBeenCalledWith("sess-1", "id-token"),
    );
    await waitFor(() => expect(screen.getByText(/何を規矩としましょう/)).toBeTruthy());
    expect(screen.getByText(/価格順で進めたい/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "会話ログをコピー" })).toBeTruthy();
  });

  it("会話ログが空なら空状態の文言を出す", async () => {
    vi.mocked(fetchMySessionTranscript).mockResolvedValue({ id: "sess-1", utterances: [] });
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    fireEvent.click(screen.getByText("会話ログ"));
    await waitFor(() =>
      expect(screen.getByText(/この会話の会話ログはまだありません/)).toBeTruthy(),
    );
  });

  it("会話ログの取得失敗は再試行導線を出し、押下で取り直す", async () => {
    vi.mocked(fetchMySessionTranscript)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(TRANSCRIPT);
    render(<PastRequirementsPage />);
    await waitFor(() => expect(screen.getByText("新機能要件定義")).toBeTruthy());
    fireEvent.click(screen.getByText("会話ログ"));
    await waitFor(() =>
      expect(screen.getByText(/会話ログの読み込みに失敗しました/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "もう一度試す" }));
    await waitFor(() => expect(screen.getByText(/何を規矩としましょう/)).toBeTruthy());
  });
});
