// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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
  driveGranted: null as boolean | null,
  requestDriveAccess: vi.fn(async () => null as string | null),
};
vi.mock("../lib/auth", () => ({ useAuth: () => authState }));

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
const DEFAULT_PRODUCT = {
  id: "p0",
  name: "既定アプリ",
  slug: "default-app" as string | null,
  description: "",
  glossary: [] as string[],
  created_at: "2024-06-20T03:00:00Z",
  github_repo: null as string | null,
  github_branch: null as string | null,
  github_commit_sha: null as string | null,
  github_index_status: "none",
    role: "owner" as const,
};
const fetchMyProducts = vi.fn(async (..._a: unknown[]) => [DEFAULT_PRODUCT] as unknown[]);
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
const listGithubBranches = vi.fn(async (..._a: unknown[]) => [] as { name: string; sha: string }[]);
const selectSessionRepo = vi.fn(async (..._a: unknown[]) => ({
  repo: null as string | null,
  branch: null as string | null,
  commit_sha: null as string | null,
  status: "none",
}));
vi.mock("../lib/api", () => ({
  fetchMyMemberInvites: () => Promise.resolve([]),
  respondMemberInvite: () => Promise.resolve({ status: "accepted", product_id: "prod-1" }),
  createSession: (...a: unknown[]) => createSession(...a),
  joinSession: (...a: unknown[]) => joinSession(...a),
  addSessionContext: (...a: unknown[]) => addSessionContext(...a),
  uploadContextFile: (...a: unknown[]) => uploadContextFile(...a),
  fetchMySessions: (...a: unknown[]) => fetchMySessions(...a),
  fetchMyProducts: (...a: unknown[]) => fetchMyProducts(...a),
  fetchGithubRepos: (...a: unknown[]) => fetchGithubRepos(...a),
  listGithubBranches: (...a: unknown[]) => listGithubBranches(...a),
  selectSessionRepo: (...a: unknown[]) => selectSessionRepo(...a),
  ACCEPTED_IMAGE: ".png,.jpg,.jpeg,image/png,image/jpeg",
  ACCEPTED_VIDEO: ".mp4,.mov,video/mp4,video/quicktime",
  ACCEPTED_DOC: ".txt,.md,.pdf,.html,.csv,.json,.docx,.xlsx,.pptx",
  ACCEPTED_SUMMARY: "画像 PNG/JPG・動画 MP4/MOV・資料 PDF/Word/Excel/PowerPoint/Markdown/HTML/CSV 等",
  classifyFileUpload: (file: { name: string; type: string }) => {
    const name = file.name.toLowerCase();
    if ([".png", ".jpg", ".jpeg"].some((e) => name.endsWith(e))) return "image";
    if ([".mp4", ".mov"].some((e) => name.endsWith(e))) return "video";
    if ([".txt", ".md", ".pdf", ".html", ".csv", ".json", ".docx", ".xlsx", ".pptx"].some((e) => name.endsWith(e)))
      return "doc";
    const type = file.type.toLowerCase();
    if (type === "image/png" || type === "image/jpeg") return "image";
    if (type === "video/mp4" || type === "video/quicktime") return "video";
    if (type === "text/plain" || type === "text/markdown") return "doc";
    return null;
  },
}));

let driveConfigured = false;
const openDrivePicker = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const importDriveFile = vi.fn(async (..._a: unknown[]) => new File(["x"], "drive.md"));
vi.mock("../lib/googleDrive", () => ({
  isDriveConfigured: () => driveConfigured,
  openDrivePicker: (...a: unknown[]) => openDrivePicker(...a),
  importDriveFile: (...a: unknown[]) => importDriveFile(...a),
}));

vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RoomAudioRenderer: () => null,
  StartAudio: () => null,
}));
vi.mock("../components/SessionView", () => ({ SessionView: () => <div>session-view</div> }));

import Home from "./page";
import EntryFlow from "../components/EntryFlow";
import PreparePage from "./prepare/page";

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
    driveConfigured = false;
    authState.driveGranted = null;
    authState.requestDriveAccess.mockClear();
    authState.requestDriveAccess.mockImplementation(async () => null);
    openDrivePicker.mockClear();
    openDrivePicker.mockImplementation(async () => []);
    importDriveFile.mockClear();
    importDriveFile.mockImplementation(async () => new File(["x"], "drive.md"));
  });
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  function selectProduct(id = "p0") {
    fireEvent.change(screen.getByLabelText("対象のプロダクト・アプリ"), { target: { value: id } });
  }

  async function clickStartCta() {
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "＋ 壁打ちを始める" }));
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

  it("アプリ未選択の間は CTA が無効で、選択すると活性化する（ADR-0044）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      { ...DEFAULT_PRODUCT, id: "p1", name: "検索アプリ" },
      { ...DEFAULT_PRODUCT, id: "p2", name: "別アプリ" },
    ]);
    render(<Home />);
    await act(async () => {});
    const cta = screen.getByText("＋ 壁打ちを始める") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(screen.getByText("対象のアプリを選ぶと壁打ちを始められます。")).toBeTruthy();
    selectProduct("p1");
    expect(cta.disabled).toBe(false);
    expect(screen.queryByText("対象のアプリを選ぶと壁打ちを始められます。")).toBeNull();
  });

  it("候補が 1 件なら自動選択され、そのまま CTA が活性化する（ADR-0044）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await act(async () => {});
    const select = screen.getByLabelText("対象のプロダクト・アプリ") as HTMLSelectElement;
    expect(select.value).toBe("p0");
    expect((screen.getByText("＋ 壁打ちを始める") as HTMLButtonElement).disabled).toBe(false);
  });

  it("登録済みアプリが 0 件ならセレクトを無効化し、CTA も塞いで登録導線を案内する（ADR-0044）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([]);
    render(<Home />);
    await act(async () => {});
    const select = screen.getByLabelText("対象のプロダクト・アプリ") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect((screen.getByText("＋ 壁打ちを始める") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("登録済みのアプリがありません。アプリ管理から登録すると選べます。"),
    ).toBeTruthy();
  });

  it("01 ホームは過去の要件一覧をページ内に持たない（サイドメニューへ移設 / 2026-07）", () => {
    authState.loggedIn = true;
    authState.credential = "idtok";
    render(<Home />);
    expect(screen.queryByRole("heading", { name: "過去の要件を見る" })).toBeNull();
    expect(fetchMySessions).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "過去の要件一覧" }).getAttribute("href")).toBe(
      "/results",
    );
    expect(screen.getByRole("link", { name: "アプリ管理" }).getAttribute("href")).toBe(
      "/products",
    );
  });

  it("CTA で 02 準備へ遷移し、役割の既定が利用者", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /利用者/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "開発者" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("02 準備はアプリ選択 UI を持たず、選択済みのアプリ名を表示する（ADR-0044）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.queryByLabelText("対象のプロダクト・アプリ")).toBeNull();
    expect(screen.getByText("対象のアプリ")).toBeTruthy();
    expect(screen.getByText("既定アプリ")).toBeTruthy();
  });

  it("CTA で 02 準備へ進むと URL が /{slug}/prepare に更新され、戻る ‹ で / に戻る", async () => {
    authState.loggedIn = true;
    window.history.replaceState(null, "", "/");
    render(<Home />);
    await clickStartCta();
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(window.location.pathname).toBe("/default-app/prepare");
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByText("会議の前に、五分の問答を")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("/{slug}/prepare 直リンクは slug のアプリで準備画面を直接描画する（ADR-0045）", async () => {
    authState.loggedIn = true;
    window.history.replaceState(null, "", "/default-app/prepare");
    render(<EntryFlow initialStep="prepare" initialSlug="default-app" />);
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.queryByText("会議の前に、五分の問答を")).toBeNull();
    await act(async () => {});
    expect(screen.getByText("セッション準備")).toBeTruthy();
    expect(screen.getByText("既定アプリ")).toBeTruthy();
  });

  it("解決できない slug（不存在・権限なし）は複合エラー画面に落とす（ADR-0045）", async () => {
    authState.loggedIn = true;
    window.history.replaceState(null, "", "/unknown-app/prepare");
    render(<EntryFlow initialStep="prepare" initialSlug="unknown-app" />);
    await act(async () => {});
    expect(
      screen.getByText("指定された URL が存在しないか、アクセスする権限がありません。"),
    ).toBeTruthy();
    expect(screen.queryByText("セッション準備")).toBeNull();
  });

  it("slug なしで 02 に入りアプリ未確定なら、候補 settle 後に 01 ホームへ戻す（ADR-0044 防衛線）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      { ...DEFAULT_PRODUCT, id: "p1", name: "検索アプリ" },
      { ...DEFAULT_PRODUCT, id: "p2", name: "別アプリ" },
    ]);
    render(<EntryFlow initialStep="prepare" />);
    expect(screen.getByText("セッション準備")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByText("会議の前に、五分の問答を")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("旧 /prepare 直リンク（PreparePage）はホームへリダイレクトする（ADR-0045 互換）", () => {
    window.history.replaceState(null, "", "/prepare");
    render(<PreparePage />);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("ブラウザの戻る/進む（popstate）で step がアドレスに追随する", () => {
    window.history.replaceState(null, "", "/default-app/prepare");
    render(<EntryFlow initialStep="prepare" initialSlug="default-app" />);
    expect(screen.getByText("セッション準備")).toBeTruthy();
    act(() => {
      window.history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("会議の前に、五分の問答を")).toBeTruthy();
  });

  it("未ログインで /{slug}/prepare 直リンクは /login?next=/{slug}/prepare へ戻す", () => {
    authState.devMode = false;
    authState.ready = true;
    authState.loggedIn = false;
    window.history.replaceState(null, "", "/default-app/prepare");
    render(<EntryFlow initialStep="prepare" initialSlug="default-app" />);
    expect(replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/default-app/prepare")}`,
    );
    expect(screen.queryByText("セッション準備")).toBeNull();
  });

  it("保存済み準備フォーム（goal/consent）を復元し、未知の role は既定 pm に戻す (#179 / Codex P2)", async () => {
    window.sessionStorage.setItem(
      "sanba.prep.v1",
      JSON.stringify({ role: "designer", goal: "復元ゴール", consent: true }),
    );
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    expect(screen.getByDisplayValue("復元ゴール")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /利用者/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("未ログインでは開始が無効でログイン導線を示す", () => {
    window.history.replaceState(null, "", "/default-app/prepare");
    render(<EntryFlow initialStep="prepare" initialSlug="default-app" />);
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("ログインへ").getAttribute("href")).toBe("/login");
  });

  it("ログイン済みでも同意 OFF の間は開始が無効で理由を示す", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("録音と AI 処理への同意が必要です。")).toBeTruthy();
  });

  it("同意 ON で開始でき、選択役割と同意が createSession に渡る", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    await act(async () => {});
    fireEvent.click(screen.getByRole("radio", { name: "開発者" }));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][0]).toEqual(["engineer"]);
    expect(createSession.mock.calls[0][1]).toBe(true);
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
    expect(window.location.pathname).toBe("/default-app/sessions/s1");
  });

  it("「連携しない」を明示選択したら github_repo に空文字を送り opt-out を保つ（ADR-0027）", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/app"],
      default: null,
    });
    render(<Home />);
    await clickStartCta();
    await act(async () => {});
    const select = screen.getByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "acme/app" } });
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("");
  });

  it("slug 未設定のアプリを選ぶと CTA は無効のまま、アプリ管理への設定導線を出す（ADR-0045）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([{ ...DEFAULT_PRODUCT, slug: null }]);
    render(<Home />);
    await act(async () => {});
    expect(
      (screen.getByRole("button", { name: "＋ 壁打ちを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/URL キーワードが未設定のため/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "アプリ管理で設定する" }).getAttribute("href")).toBe(
      "/products/p0",
    );
  });

  it("ホーム表示だけでは候補一覧を取得しない（02 準備で初めて取得する / Codex P2）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await waitFor(() => expect(fetchMyProducts).toHaveBeenCalled());
    expect(fetchGithubRepos).not.toHaveBeenCalled();
    await clickStartCta();
    await waitFor(() => expect(fetchGithubRepos).toHaveBeenCalledTimes(1));
  });

  it("コネクタ無効（既定）では連携リポジトリのフィールドを出さない", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
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
    await clickStartCta();
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "acme/product-a" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("acme/product-a");
  });

  it("未タッチの空選択は github_repo を送らず product 継承に委ねる（ADR-0031）", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a"],
      default: null,
    });
    render(<Home />);
    await clickStartCta();
    await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBeUndefined();
  });

  it("既定リポジトリは初期選択に反映され、そのまま開始すると既定が渡る", async () => {
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["acme/product-a", "o/r"],
      default: "o/r",
    });
    render(<Home />);
    await clickStartCta();
    const select = (await screen.findByLabelText(
      "連携リポジトリ（任意）",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("o/r"));
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][4]).toBe("o/r");
  });

  it("保存済みの「連携しない」（空文字）は既定リポの初期選択で上書きされない", async () => {
    window.sessionStorage.setItem("sanba.prep.v1", JSON.stringify({ githubRepo: "" }));
    authState.loggedIn = true;
    fetchGithubRepos.mockResolvedValueOnce({
      enabled: true,
      repos: ["o/r"],
      default: "o/r",
    });
    render(<Home />);
    await clickStartCta();
    const select = (await screen.findByLabelText("連携リポジトリ（任意）")) as HTMLSelectElement;
    await act(async () => {});
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
    await clickStartCta();
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement;
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
    await clickStartCta();
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
    await clickStartCta();
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "acme/product-a" } });
    expect(screen.queryByLabelText("ブランチ")).toBeNull();
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(selectSessionRepo).not.toHaveBeenCalled();
  });

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
    await clickStartCta();
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    const branchSelect = await screen.findByLabelText("ブランチ");
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
    await clickStartCta();
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    await screen.findByLabelText("ブランチ");
    await waitFor(() =>
      expect((screen.getByLabelText("ブランチ") as HTMLSelectElement).value).toBe("main"),
    );
    fireEvent.change(screen.getByLabelText("ブランチ"), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(selectSessionRepo).toHaveBeenCalledTimes(1));
    expect(selectSessionRepo).toHaveBeenCalledWith("s1", "octo/demo", "dev", "st");
    expect(createSession.mock.calls[0][4]).toBe("octo/demo");
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
  });

  it("索引キック（バインド）に失敗したら開始を止めて理由を出す（Codex P2）", async () => {
    authState.loggedIn = true;
    mockLinkedRepos();
    selectSessionRepo.mockRejectedValueOnce(new Error("bind failed: 502"));
    render(<Home />);
    await clickStartCta();
    const select = await screen.findByLabelText("連携リポジトリ（任意）");
    fireEvent.change(select, { target: { value: "octo/demo" } });
    await screen.findByLabelText("ブランチ");
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(selectSessionRepo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/紐づけに失敗しました/)).toBeTruthy();
    expect(screen.queryByText("支度、相整いまして")).toBeNull();
  });

  async function gotoPrepare() {
    authState.loggedIn = true;
    const view = render(<Home />);
    await clickStartCta();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    return view;
  }

  function pickFiles(container: HTMLElement, files: File[]) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  }

  it("「＋ ファイルを追加」で手段選択シートが開き、アップロード/Drive のみ（カメラ/画面共有は出さない）", async () => {
    await gotoPrepare();
    fireEvent.click(screen.getByRole("button", { name: "ファイルを追加" }));
    expect(screen.getByRole("dialog", { name: "資料の追加方法" })).toBeTruthy();
    expect(screen.getByText("ファイルをアップロード")).toBeTruthy();
    expect(screen.getByText("Google ドライブから選ぶ")).toBeTruthy();
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
    const bad = new File(["x"], "malware.exe", { type: "application/octet-stream" });
    pickFiles(container, [bad]);
    expect(screen.getByRole("alert").textContent).toContain("対応していない形式");
    expect(screen.queryByRole("list", { name: "添付した参考資料" })).toBeNull();
  });

  it("資料（Markdown/PDF/Office）もステージできる（ADR-0049）", async () => {
    const { container } = await gotoPrepare();
    pickFiles(container, [
      new File(["# spec"], "spec.md", { type: "text/markdown" }),
      new File(["%PDF"], "prd.pdf", { type: "application/pdf" }),
      new File(["PK"], "req.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ]);
    const list = screen.getByRole("list", { name: "添付した参考資料" }).textContent;
    expect(list).toContain("spec.md");
    expect(list).toContain("prd.pdf");
    expect(list).toContain("req.xlsx");
    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(uploadContextFile.mock.calls[0][2]).toBe("st");
    expect((uploadContextFile.mock.calls[0][1] as File).name).toBe("PRD.png");
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
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
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
    await clickStartCta();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    pickFiles(container, [new File(["x"], "a.png", { type: "image/png" })]);
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    expect(
      (screen.getByRole("button", { name: "ファイルを追加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "a.png を取り外す" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      release({ session_id: "s1", invites: { pm: "inv-pm" } });
    });
  });

  it("Drive 取り込み中は開始・追加を無効化し、完了後にステージへ載る（ADR-0049 / Codex P2）", async () => {
    driveConfigured = true;
    authState.requestDriveAccess.mockImplementation(async () => "drive-tok");
    openDrivePicker.mockImplementation(async () => [
      { id: "d1", name: "要件メモ", mimeType: "application/vnd.google-apps.document" },
    ]);
    let releaseImport: (f: File) => void = () => {};
    importDriveFile.mockReturnValue(new Promise<File>((r) => { releaseImport = r; }));
    await gotoPrepare();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ファイルを追加" }));
    fireEvent.click(screen.getByRole("button", { name: /Google ドライブから選ぶ/ }));
    await waitFor(() => expect(importDriveFile).toHaveBeenCalled());
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "ファイルを追加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      releaseImport(new File(["# memo"], "要件メモ.md", { type: "text/markdown" }));
    });
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "添付した参考資料" }).textContent,
      ).toContain("要件メモ.md"),
    );
    expect(
      (screen.getByRole("button", { name: "要件サンバを始める" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("Drive 権限が未許可なら取り込まず、シート内で再同意を促す文言を出す（ADR-0049）", async () => {
    driveConfigured = true;
    authState.requestDriveAccess.mockImplementation(async () => null);
    await gotoPrepare();
    fireEvent.click(screen.getByRole("button", { name: "ファイルを追加" }));
    fireEvent.click(screen.getByRole("button", { name: /Google ドライブから選ぶ/ }));
    await waitFor(() => expect(authState.requestDriveAccess).toHaveBeenCalled());
    expect(openDrivePicker).not.toHaveBeenCalled();
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.length).toBeGreaterThan(0);
      for (const alert of alerts) {
        expect(alert.textContent).toContain("アクセスが許可されていません");
      }
    });
  });

  it("開始処理中は二重送信できない", async () => {
    authState.loggedIn = true;
    let release: (v: Awaited<ReturnType<typeof createSession>>) => void = () => {};
    createSession.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    render(<Home />);
    await clickStartCta();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const cta = screen.getByRole("button", { name: "要件サンバを始める" });
    fireEvent.click(cta);
    fireEvent.click(cta);
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("準備しています…")).toBeTruthy();
    await act(async () => {
      release({ session_id: "s1", invites: { pm: "inv-pm" } });
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("ゴールのプレースホルダが更新され、例は役割で切り替わる表示専用テキスト（#222）", async () => {
    await gotoPrepare();
    const goal = screen.getByLabelText("ゴール") as HTMLTextAreaElement;
    expect(goal.getAttribute("placeholder")).toBe("ゴールを入力・・・");
    expect(screen.getByText("例：ボタンを押しても動かない状況を改善したい")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /ボタンを押しても動かない状況を改善したい/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "企画者" }));
    expect(screen.getByText("例：検索機能のリニューアル要件を固めたい")).toBeTruthy();
    expect(screen.queryByText("例：ボタンを押しても動かない状況を改善したい")).toBeNull();
  });

  it("ゴール未入力の間は開始できず理由を示す（必須 / #222）", async () => {
    authState.loggedIn = true;
    render(<Home />);
    await clickStartCta();
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox"));
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

  it("ゴール・詳細は createSession にも渡り SessionMeta へ保存される（ADR-0035）", async () => {
    await gotoPrepare();
    fireEvent.change(screen.getByLabelText("ゴールの詳細"), {
      target: { value: "現状は検索が遅い。範囲と優先度を整理したい。" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][6]).toBe("テストゴール");
    expect(createSession.mock.calls[0][7]).toBe("現状は検索が遅い。範囲と優先度を整理したい。");
  });

  it("同意文言と開始ボタン文言が更新されている（#222）", async () => {
    await gotoPrepare();
    expect(screen.getByText("録音と AI 処理に同意します（最大 30 日保持）。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "要件サンバを始める" })).toBeTruthy();
  });

  it("登録済みプロダクトを選ぶと product_id を渡し用語文脈を投入する（repo は API 継承 / ADR-0031）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "検索アプリ",
        slug: "search-app",
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
    await clickStartCta();
    expect(screen.getByText("検索アプリ")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("ゴール"), { target: { value: "テストゴール" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "要件サンバを始める" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][5]).toBe("p1");
    expect(createSession.mock.calls[0][4]).toBeUndefined();
    expect(selectSessionRepo).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(addSessionContext.mock.calls.some((c) => c[3] === "product")).toBe(true),
    );
  });

  it("stale な productId（候補に無い保存値）はクリアし、開始を塞ぐ（PR#314 P2）", async () => {
    window.sessionStorage.setItem("sanba.prep.v1", JSON.stringify({ productId: "gone" }));
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "検索アプリ",
        slug: "search-app",
        description: "",
        glossary: [],
        created_at: "2024-06-20T03:00:00Z",
        github_repo: null,
        github_branch: null,
        github_commit_sha: null,
        github_index_status: "none",
    role: "owner" as const,
      },
      {
        id: "p2",
        name: "別アプリ",
        slug: "other-app",
        description: "",
        glossary: [],
        created_at: "2024-06-20T03:00:00Z",
        github_repo: null,
        github_branch: null,
        github_commit_sha: null,
        github_index_status: "none",
    role: "owner" as const,
      },
    ]);
    render(<Home />);
    const select = (await screen.findByLabelText("対象のプロダクト・アプリ")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
    expect(
      (screen.getByRole("button", { name: "＋ 壁打ちを始める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    selectProduct("p2");
    expect(
      (screen.getByRole("button", { name: "＋ 壁打ちを始める" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
