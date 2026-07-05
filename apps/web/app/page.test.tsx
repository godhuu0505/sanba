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
vi.mock("../lib/auth", () => ({ useAuth: () => authState }));

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
const uploadContextFile = vi.fn(async (..._a: unknown[]) => ({ indexed_chunks: 1 }));
const fetchMySessions = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
// 対象プロダクト候補（ADR-0031）。対象アプリは開始の必須条件なので、既定で 1 件返し
// 開始系テストが選択できるようにする（0 件の挙動は個別テストで上書きして検証する）。
const DEFAULT_PRODUCT = {
  id: "p0",
  name: "既定アプリ",
  description: "",
  glossary: [] as string[],
  created_at: "2024-06-20T03:00:00Z",
  github_repo: null as string | null,
  github_branch: null as string | null,
  github_commit_sha: null as string | null,
  github_index_status: "none",
};
const fetchMyProducts = vi.fn(async (..._a: unknown[]) => [DEFAULT_PRODUCT] as unknown[]);
// 連携リポジトリ候補（ADR-0027）。既定はコネクタ無効 = フィールド非表示（既存テストを変えない）。
// linked/items は GitHub App 連携時の additive 拡張（ADR-0028）。
const fetchGithubRepos = vi.fn(
  async (..._a: unknown[]) =>
    ({ enabled: false, repos: [], default: null }) as {
      enabled: boolean;
      repos: string[];
      default: string | null;
      linked?: boolean;
      items?: { full_name: string; default_branch: string; private: boolean }[];
    },
);
// GitHub App 連携の拡張（ADR-0028）: branch 一覧と開始時の索引キック。
const listGithubBranches = vi.fn(async (..._a: unknown[]) => [] as { name: string; sha: string }[]);
const selectSessionRepo = vi.fn(async (..._a: unknown[]) => ({
  repo: null as string | null,
  branch: null as string | null,
  commit_sha: null as string | null,
  status: "none",
}));
vi.mock("../lib/api", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  joinSession: (...a: unknown[]) => joinSession(...a),
  addSessionContext: (...a: unknown[]) => addSessionContext(...a),
  uploadContextFile: (...a: unknown[]) => uploadContextFile(...a),
  fetchMySessions: (...a: unknown[]) => fetchMySessions(...a),
  fetchMyProducts: (...a: unknown[]) => fetchMyProducts(...a),
  fetchGithubRepos: (...a: unknown[]) => fetchGithubRepos(...a),
  listGithubBranches: (...a: unknown[]) => listGithubBranches(...a),
  selectSessionRepo: (...a: unknown[]) => selectSessionRepo(...a),
  // 実装と同じ受理範囲・判定（PNG/JPG・MP4/MOV）。テストではロジックをそのまま使う。
  ACCEPTED_IMAGE: ".png,.jpg,.jpeg,image/png,image/jpeg",
  ACCEPTED_VIDEO: ".mp4,.mov,video/mp4,video/quicktime",
  classifyUpload: (filename: string) => {
    const name = filename.toLowerCase();
    if ([".png", ".jpg", ".jpeg"].some((e) => name.endsWith(e))) return "image";
    if ([".mp4", ".mov"].some((e) => name.endsWith(e))) return "video";
    return null;
  },
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
    uploadContextFile.mockClear();
    uploadContextFile.mockImplementation(async () => ({ indexed_chunks: 1 }));
    fetchMySessions.mockClear();
    fetchMySessions.mockImplementation(async () => []);
    fetchMyProducts.mockClear();
    fetchMyProducts.mockImplementation(async () => [DEFAULT_PRODUCT]);
    fetchGithubRepos.mockClear();
    fetchGithubRepos.mockImplementation(async () => ({
      enabled: false,
      repos: [],
      default: null,
    }));
    listGithubBranches.mockClear();
    listGithubBranches.mockImplementation(async () => []);
    selectSessionRepo.mockClear();
    selectSessionRepo.mockImplementation(async () => ({
      repo: null,
      branch: null,
      commit_sha: null,
      status: "none",
    }));
  });
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  // 対象アプリは開始の必須条件（ADR-0031）。候補 settle 後に既定アプリを選ぶ共通操作。
  function selectProduct(id = "p0") {
    fireEvent.change(screen.getByLabelText("対象のプロダクト・アプリ"), { target: { value: id } });
  }

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
    // 未ログインなので履歴は取得しない＝空状態。遷移リンクは出さない。
    expect(screen.getByText(/過去の要件はまだございません/)).toBeTruthy();
    expect(fetchMySessions).not.toHaveBeenCalled();
  });

  // ── 01 履歴リスト結線（#250 / #215 follow-up）─────────────────────────────
  it("ログイン済みなら本人のセッション履歴を取得し、標題と日付を一覧表示する（#250）", async () => {
    authState.loggedIn = true;
    authState.credential = "idtok";
    fetchMySessions.mockResolvedValueOnce([
      {
        id: "sess-1",
        title: "新機能要件定義",
        created_at: "2024-06-20T03:00:00Z",
        status: "active",
        finalized: false,
      },
    ]);
    render(<Home />);
    // idToken を渡して取得する（ADR-0012）。
    await waitFor(() => expect(fetchMySessions).toHaveBeenCalledWith("idtok"));
    expect(await screen.findByText("新機能要件定義")).toBeTruthy();
    // 日付は YYYY/MM/DD へ整形して表示する（タイムゾーン差を避け書式のみ検証）。
    expect(screen.getByText(/^\d{4}\/\d{2}\/\d{2}$/)).toBeTruthy();
    // 行は過去要件の絵巻閲覧画面（/sessions/{id}）への遷移リンクになる。
    expect(screen.getByRole("link", { name: /新機能要件定義/ }).getAttribute("href")).toBe(
      "/sessions/sess-1",
    );
    // 空状態の文言は出ない。
    expect(screen.queryByText(/過去の要件はまだございません/)).toBeNull();
  });

  it("履歴が 0 件なら空状態の文言を維持する（#250）", async () => {
    authState.loggedIn = true;
    authState.credential = "idtok";
    fetchMySessions.mockResolvedValueOnce([]);
    render(<Home />);
    await waitFor(() => expect(fetchMySessions).toHaveBeenCalled());
    expect(screen.getByText(/過去の要件はまだございません/)).toBeTruthy();
  });

  it("履歴取得が失敗しても空状態を維持し、ホームは壊れない（#250）", async () => {
    authState.loggedIn = true;
    authState.credential = "idtok";
    fetchMySessions.mockRejectedValueOnce(new Error("fetch my sessions failed: 500"));
    render(<Home />);
    await waitFor(() => expect(fetchMySessions).toHaveBeenCalled());
    expect(screen.getByText(/過去の要件はまだございません/)).toBeTruthy();
    // 本流（壁打ち開始 CTA）は出続ける。
    expect(screen.getByText("＋ 壁打ちを始める")).toBeTruthy();
  });

  it("CTA で 02 準備へ遷移し、役割の既定が利用者", () => {
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /利用者/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "開発者" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("保存済み準備フォーム（goal/consent）を復元し、未知の role は既定 pm に戻す (#179 / Codex P2)", () => {
    // 古い/壊れた保存値（role:"designer"）＋ goal/consent を seed。
    window.sessionStorage.setItem(
      "sanba.prep.v1",
      JSON.stringify({ role: "designer", goal: "復元ゴール", consent: true }),
    );
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    // goal/consent は復元される。
    expect(screen.getByDisplayValue("復元ゴール")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    // 未知 role は適用せず既定 customer（チップ未選択や未サポート role の createSession を防ぐ）。
    expect(screen.getByRole("radio", { name: /利用者/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("未ログインでは開始が無効でログイン導線を示す", () => {
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("ログインへ").getAttribute("href")).toBe("/login");
  });

  it("ログイン済みでも同意 OFF の間は開始が無効で理由を示す", () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("録音と AI 処理への同意が必要です。")).toBeTruthy();
  });

  it("同意 ON で開始でき、選択役割と同意が createSession に渡る", async () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    // 候補取得の settle を待つ（取得中は開始が無効 / Codex P2）。
    await act(async () => {});
    fireEvent.click(screen.getByRole("radio", { name: "開発者" }));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][0]).toEqual(["engineer"]);
    expect(createSession.mock.calls[0][1]).toBe(true);
    // 開始後は 03 会話開始（開始前サマリ）へ。接続/許可はここから先（ConversationStart）。
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
  });

  // ── 02 連携リポジトリ（ADR-0027）─────────────────────────────────────────
  it("ホーム表示だけでは候補一覧を取得しない（02 準備で初めて取得する / Codex P2）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    // ホーム（01）では叩かない = /user/repos 全ページ取得を無駄に発火させない。
    await waitFor(() => expect(fetchMySessions).toHaveBeenCalled());
    expect(fetchGithubRepos).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await waitFor(() => expect(fetchGithubRepos).toHaveBeenCalledTimes(1));
  });

  it("コネクタ無効（既定）では連携リポジトリのフィールドを出さない", async () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await waitFor(() => expect(fetchGithubRepos).toHaveBeenCalled());
    expect(screen.queryByLabelText("連携リポジトリ（任意）")).toBeNull();
  });

  it("候補一覧から選んだリポジトリが createSession に渡る", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a", "acme/product-b"],
      default: null,
    });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "acme/product-a" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // (roles, consent, idToken, title, githubRepo)
    expect(createSession.mock.calls[0][4]).toBe("acme/product-a");
  });

  it("「連携しない」は空文字（明示的オプトアウト）として createSession に渡る", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a"],
      default: null,
    });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // 空文字 = 「既定リポジトリにも送らない」を API に明示する（Codex P2）。
    expect(createSession.mock.calls[0][4]).toBe("");
  });

  it("既定リポジトリは初期選択に反映され、そのまま開始すると既定が渡る", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a", "o/r"],
      default: "o/r",
    });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = (await screen.findByLabelText(
      "連携リポジトリ（任意）",
    )) as HTMLSelectElement;
    // 表示と挙動の一致（Codex P2）: フォールバック先が選択状態として見える。
    await waitFor(() => expect(select.value).toBe("o/r"));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("o/r");
  });

  it("保存済みの「連携しない」（空文字）は既定リポの初期選択で上書きされない", async () => {
    // 前回明示的に「連携しない」を選んで保存されている状態（Codex P2）。
    window.sessionStorage.setItem("sanba.prep.v1", JSON.stringify({ githubRepo: "" }));
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["o/r"],
      default: "o/r",
    });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = (await screen.findByLabelText("連携リポジトリ（任意）")) as HTMLSelectElement;
    await act(async () => {});
    // 既定 "o/r" で上書きされず「連携しない」のまま。
    expect(select.value).toBe("");
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("");
  });

  it("候補取得が終わるまで開始は無効（確認前の既定リポ起票を防ぐ / Codex P2）", async () => {
    authState.loggedIn = true;
    let resolveFetch!: (v: { enabled: boolean; repos: string[]; default: string | null }) => void;
    fetchGithubRepos.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement;
    // 取得中は無効。settle（成功/失敗どちらでも）で解放される。
    expect(cta.disabled).toBe(true);
    await act(async () => {
      resolveFetch({ enabled: false, repos: [], default: null });
    });
    expect(cta.disabled).toBe(false);
  });

  it("候補一覧が空（取得失敗）でも手入力欄にフォールバックして選べる", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({ enabled: true, repos: [], default: null });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const input = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(input, { target: { value: "acme/manual" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("acme/manual");
  });

  it("connector 由来（App 未連携）の選択では branch 選択を出さず、索引キックも呼ばない", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a"],
      default: null,
    });
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "acme/product-a" } });
    expect(screen.queryByLabelText("ブランチ")).toBeNull();
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(selectSessionRepo).not.toHaveBeenCalled();
  });

  // ── 02 GitHub App 連携の repo+branch（ADR-0028 拡張）───────────────────────
  function mockLinkedRepos() {
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["octo/demo"],
      default: null,
      linked: true,
      items: [{ full_name: "octo/demo", default_branch: "main", private: true }],
    });
    listGithubBranches.mockResolvedValueOnce([
      { name: "dev", sha: "s1" },
      { name: "main", sha: "s2" },
    ]);
  }

  it("App 連携済み候補を選ぶと branch 選択が出て、既定はデフォルトブランチ", async () => {
    authState.loggedIn = true;
    mockLinkedRepos();
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    const branchSelect = await screen.findByLabelText("ブランチ");
    // branch 一覧を idToken で取得し、既定はデフォルトブランチ（main）。
    await waitFor(() => expect(listGithubBranches).toHaveBeenCalledWith("octo/demo", null));
    await waitFor(() =>
      expect((screen.getByLabelText("ブランチ") as HTMLSelectElement).value).toBe("main"),
    );
    expect(branchSelect.textContent).toContain("dev");
  });

  it("App 連携候補で開始すると join 後に repo+branch をバインドし索引をキックする", async () => {
    authState.loggedIn = true;
    mockLinkedRepos();
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    await screen.findByLabelText("ブランチ");
    await waitFor(() =>
      expect((screen.getByLabelText("ブランチ") as HTMLSelectElement).value).toBe("main"),
    );
    // デフォルト以外の branch も選べる。
    fireEvent.change(screen.getByLabelText("ブランチ"), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(selectSessionRepo).toHaveBeenCalledTimes(1));
    // (sessionId, repo, branch, sessionToken)。join 済みトークンで認可する（契約 §4）。
    expect(selectSessionRepo).toHaveBeenCalledWith("s1", "octo/demo", "dev", "st");
    // createSession にも repo が渡る（起票先・Issue/README 文脈は #283 の経路のまま）。
    expect(createSession.mock.calls[0][4]).toBe("octo/demo");
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
  });

  it("索引キック（バインド）に失敗したら開始を止めて理由を出す（Codex P2）", async () => {
    authState.loggedIn = true;
    mockLinkedRepos();
    selectSessionRepo.mockRejectedValueOnce(new Error("bind failed: 502"));
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    await screen.findByLabelText("ブランチ");
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(selectSessionRepo).toHaveBeenCalledTimes(1));
    // 03 開始前サマリへは進まず、02 のまま理由を表示する。
    expect(await screen.findByText(/紐づけに失敗しました/)).toBeTruthy();
    expect(screen.queryByText("支度、相整いまして")).toBeNull();
  });

  // ── 02 参考資料（バイナリ添付）#222 ──────────────────────────────────────
  // 候補取得（fetchGithubRepos）が settle するまで CTA は無効（Codex P2）なので、
  // 準備画面に入ったらマイクロタスクを流して repoLoading を落としてから操作する。
  async function gotoPrepare() {
    authState.loggedIn = true;
    const view = render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await act(async () => {});
    // ゴール・対象アプリは開始の必須条件（#222 / ADR-0031）。既定で埋め、開始系テストの前提を揃える。
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    selectProduct();
    return view;
  }

  function pickFiles(container: HTMLElement, files: File[]) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  }

  it("「＋ ファイルを追加」で手段選択シートが開き、アップロード/Drive のみ（カメラ/画面共有は出さない）", async () => {
    await gotoPrepare();
    fireEvent.click(screen.getByRole("button", { name: "＋ ファイルを追加" }));
    expect(screen.getByRole("dialog", { name: "資料の追加方法" })).toBeTruthy();
    expect(screen.getByText("ファイルをアップロード")).toBeTruthy();
    expect(screen.getByText("Google ドライブから選ぶ")).toBeTruthy();
    // 準備画面は LiveKit ルーム外のためカメラ/画面共有の導線は出さない（#201 再利用条件）。
    expect(screen.queryByText("カメラで撮影")).toBeNull();
    expect(screen.queryByText("画面を共有")).toBeNull();
  });

  it("ファイルを添付するとチップ表示され、削除できる", async () => {
    const { container } = await gotoPrepare();
    const png = new File(["x"], "mock.png", { type: "image/png" });
    pickFiles(container, [png]);
    const list = screen.getByRole("list", { name: "添付した参考資料" });
    expect(list.textContent).toContain("mock.png");
    fireEvent.click(screen.getByRole("button", { name: "mock.png を取り外す" }));
    expect(screen.queryByText("mock.png")).toBeNull();
  });

  it("非対応形式は弾いて理由を出し、ステージしない", async () => {
    const { container } = await gotoPrepare();
    const bad = new File(["x"], "secret.txt", { type: "text/plain" });
    pickFiles(container, [bad]);
    expect(screen.getByRole("alert").textContent).toContain("対応していない形式");
    expect(screen.queryByRole("list", { name: "添付した参考資料" })).toBeNull();
  });

  it("開始時にステージ済みファイルが join 後に投入され、03-0 サマリに件数/名が反映される", async () => {
    const { container } = await gotoPrepare();
    fireEvent.click(screen.getByRole("checkbox"));
    pickFiles(container, [
      new File(["x"], "PRD.png", { type: "image/png" }),
      new File(["y"], "demo.mp4", { type: "video/mp4" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(uploadContextFile).toHaveBeenCalledTimes(2));
    // join 済みトークン（session_token）で投入する（契約 §4）。
    expect(uploadContextFile.mock.calls[0][2]).toBe("st");
    expect((uploadContextFile.mock.calls[0][1] as File).name).toBe("PRD.png");
    // 03-0 開始前サマリの「参考資料」に名前＋件数が出る（固定文の置換 / 監査 B-2 #11）。
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
    expect(screen.getByText(/PRD\.png ・ 他1件/)).toBeTruthy();
    expect(screen.getByText(/（計2件）/)).toBeTruthy();
  });

  it("投入失敗分は開始は止めず、サマリで添付済み扱いにせず失敗件数を出す（Codex P2）", async () => {
    const { container } = await gotoPrepare();
    fireEvent.click(screen.getByRole("checkbox"));
    uploadContextFile.mockRejectedValueOnce(new Error("upload failed: 500"));
    pickFiles(container, [new File(["x"], "ng.png", { type: "image/png" })]);
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    // 失敗しても開始前サマリ（03-0）へ進む。
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
    // 失敗分は「添付済み」に出さない（誤認防止）。0 件成功なので従来文言＋失敗注記。
    expect(screen.queryByText(/ng\.png/)).toBeNull();
    expect(screen.getByText("会話中に追加できます")).toBeTruthy();
    expect(screen.getByText(/1件は投入できませんでした/)).toBeTruthy();
  });

  it("拡張子が無くても MIME が画像/動画なら受理する（API と整合 / Codex P2）", async () => {
    const { container } = await gotoPrepare();
    pickFiles(container, [new File(["x"], "clipboard-image", { type: "image/png" })]);
    expect(
      screen.getByRole("list", { name: "添付した参考資料" }).textContent,
    ).toContain("clipboard-image");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("開始処理中は添付の追加/削除を無効化する（Codex P2）", async () => {
    authState.loggedIn = true;
    let release: (v: Awaited<ReturnType<typeof createSession>>) => void = () => {};
    createSession.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const { container } = render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await act(async () => {}); // 候補取得の settle（取得中は開始が無効 / Codex P2）
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    pickFiles(container, [new File(["x"], "a.png", { type: "image/png" })]);
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    expect(
      (screen.getByRole("button", { name: "＋ ファイルを追加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "a.png を取り外す" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      release({ session_id: "s1", invites: { pm: "inv-pm" } });
    });
  });

  it("開始処理中は二重送信できない", async () => {
    authState.loggedIn = true;
    let release: (v: Awaited<ReturnType<typeof createSession>>) => void = () => {};
    createSession.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await act(async () => {}); // 候補取得の settle（取得中は開始が無効 / Codex P2）
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    fireEvent.click(cta);
    fireEvent.click(cta); // 連打
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("準備しています…")).toBeTruthy();
    await act(async () => {
      release({ session_id: "s1", invites: { pm: "inv-pm" } });
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  // ── 02 ゴール（プレースホルダ・役割別の例・詳細）/ 対象プロダクト #222・ADR-0031 ──
  it("ゴールのプレースホルダが更新され、例は役割で切り替わる表示専用テキスト（#222）", async () => {
    await gotoPrepare();
    const goal = screen.getByLabelText("ゴール") as HTMLTextAreaElement;
    expect(goal.getAttribute("placeholder")).toBe("ゴールを入力・・・");
    // 既定（利用者）の記入例。表示専用なのでボタンではない。
    expect(screen.getByText("例：ボタンを押しても動かない状況を改善したい")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /ボタンを押しても動かない状況を改善したい/ }),
    ).toBeNull();
    // 役割を企画者に切り替えると例文も企画者向けに変わる。
    fireEvent.click(screen.getByRole("radio", { name: "企画者" }));
    expect(screen.getByText("例：検索機能のリニューアル要件を固めたい")).toBeTruthy();
    expect(screen.queryByText("例：ボタンを押しても動かない状況を改善したい")).toBeNull();
  });

  it("ゴール未入力の間は開始できず理由を示す（必須 / #222）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox"));
    // 同意済み・候補 settle 済みでも、ゴールが空なら開始は無効。
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("ゴールの入力が必要です。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("ゴールの詳細は goal_detail 文脈として開始時に投入する（#222）", async () => {
    await gotoPrepare();
    fireEvent.change(screen.getByLabelText("ゴールの詳細"), {
      target: { value: "現状は検索が遅い。範囲と優先度を整理したい。" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        addSessionContext.mock.calls.some(
          (c) => c[3] === "goal_detail" && c[1] === "現状は検索が遅い。範囲と優先度を整理したい。",
        ),
      ).toBe(true),
    );
  });

  it("ゴール・詳細は createSession にも渡り SessionMeta へ保存される（ADR-0034）", async () => {
    // agent の初期前提はこちらが正本（join 後の RAG 投入は agent 起動と競合し得るため）。
    await gotoPrepare();
    fireEvent.change(screen.getByLabelText("ゴールの詳細"), {
      target: { value: "現状は検索が遅い。範囲と優先度を整理したい。" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // 位置引数: (roles, consent, idToken, title, githubRepo, productId, goal, goalDetail)
    expect(createSession.mock.calls[0][6]).toBe("テストゴール");
    expect(createSession.mock.calls[0][7]).toBe("現状は検索が遅い。範囲と優先度を整理したい。");
  });

  it("同意文言と開始ボタン文言が更新されている（#222）", async () => {
    await gotoPrepare();
    expect(screen.getByText("録音と AI 処理に同意します（最大 30 日保持）。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "要件サンバを始める" })).toBeTruthy();
  });

  it("プロダクト候補が 0 件でもセレクトは常に表示し、無効化して開始も塞ぐ（ADR-0031）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([]);
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    await act(async () => {});
    const select = screen.getByLabelText("対象のプロダクト・アプリ") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    // 未選択なので、ゴール・同意を満たしても開始は無効（fail-closed）。
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("対象のプロダクト・アプリの選択が必要です。")).toBeTruthy();
  });

  it("登録済みプロダクトを選ぶと product_id を渡し用語文脈を投入する（repo は API 継承 / ADR-0031）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "検索アプリ",
        description: "社内ドキュメント検索",
        glossary: ["絞り込み", "サジェスト"],
        created_at: "2024-06-20T03:00:00Z",
        github_repo: "acme/search",
        github_branch: "main",
        github_commit_sha: null,
        github_index_status: "ready",
      },
    ]);
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    const select = await screen.findByLabelText("対象のプロダクト・アプリ");
    fireEvent.change(select, { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // product_id を createSession に渡す（API 側で SessionMeta に紐づけ、前提 repo を継承する）。
    // (roles, consent, idToken, title, githubRepo, productId)
    expect(createSession.mock.calls[0][5]).toBe("p1");
    // コネクタ無効時は github_repo を明示送信せず undefined（product 継承に委ねる）。
    expect(createSession.mock.calls[0][4]).toBeUndefined();
    // 前提 repo のクライアント側バインド（selectSessionRepo）はしない（API 継承 / PR#314 P1）。
    expect(selectSessionRepo).not.toHaveBeenCalled();
    // 用語/説明は補助グラウンディングとして product 文脈に投入する。
    await waitFor(() =>
      expect(addSessionContext.mock.calls.some((c) => c[3] === "product")).toBe(true),
    );
  });

  it("stale な productId（候補に無い保存値）はクリアし、開始を塞ぐ（PR#314 P2）", async () => {
    // 削除済み product の id が sessionStorage に残っているケース。
    window.sessionStorage.setItem("sanba.prep.v1", JSON.stringify({ productId: "gone" }));
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "検索アプリ",
        description: "",
        glossary: [],
        created_at: "2024-06-20T03:00:00Z",
        github_repo: null,
        github_branch: null,
        github_commit_sha: null,
        github_index_status: "none",
      },
      {
        id: "p2",
        name: "別アプリ",
        description: "",
        glossary: [],
        created_at: "2024-06-20T03:00:00Z",
        github_repo: null,
        github_branch: null,
        github_commit_sha: null,
        github_index_status: "none",
      },
    ]);
    render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    // 候補は 2 件（自動選択しない）。stale な "gone" はクリアされ未選択に戻る。
    const select = (await screen.findByLabelText("対象のプロダクト・アプリ")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
