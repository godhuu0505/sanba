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
vi.mock("../lib/api", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  joinSession: (...a: unknown[]) => joinSession(...a),
  addSessionContext: (...a: unknown[]) => addSessionContext(...a),
  uploadContextFile: (...a: unknown[]) => uploadContextFile(...a),
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

  // ── 02 参考資料（バイナリ添付）#222 ──────────────────────────────────────
  function gotoPrepare() {
    authState.loggedIn = true;
    const view = render(<Home />);
    fireEvent.click(screen.getByText("＋ 壁打ちを始める"));
    return view;
  }

  function pickFiles(container: HTMLElement, files: File[]) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  }

  it("「＋ ファイルを追加」で手段選択シートが開き、アップロード/Drive のみ（カメラ/画面共有は出さない）", () => {
    gotoPrepare();
    fireEvent.click(screen.getByRole("button", { name: "＋ ファイルを追加" }));
    expect(screen.getByRole("dialog", { name: "資料の追加方法" })).toBeTruthy();
    expect(screen.getByText("ファイルをアップロード")).toBeTruthy();
    expect(screen.getByText("Google ドライブから選ぶ")).toBeTruthy();
    // 準備画面は LiveKit ルーム外のためカメラ/画面共有の導線は出さない（#201 再利用条件）。
    expect(screen.queryByText("カメラで撮影")).toBeNull();
    expect(screen.queryByText("画面を共有")).toBeNull();
  });

  it("ファイルを添付するとチップ表示され、削除できる", () => {
    const { container } = gotoPrepare();
    const png = new File(["x"], "mock.png", { type: "image/png" });
    pickFiles(container, [png]);
    const list = screen.getByRole("list", { name: "添付した参考資料" });
    expect(list.textContent).toContain("mock.png");
    fireEvent.click(screen.getByRole("button", { name: "mock.png を取り外す" }));
    expect(screen.queryByText("mock.png")).toBeNull();
  });

  it("非対応形式は弾いて理由を出し、ステージしない", () => {
    const { container } = gotoPrepare();
    const bad = new File(["x"], "secret.txt", { type: "text/plain" });
    pickFiles(container, [bad]);
    expect(screen.getByRole("alert").textContent).toContain("対応していない形式");
    expect(screen.queryByRole("list", { name: "添付した参考資料" })).toBeNull();
  });

  it("開始時にステージ済みファイルが join 後に投入され、03-0 サマリに件数/名が反映される", async () => {
    const { container } = gotoPrepare();
    fireEvent.click(screen.getByRole("checkbox"));
    pickFiles(container, [
      new File(["x"], "PRD.png", { type: "image/png" }),
      new File(["y"], "demo.mp4", { type: "video/mp4" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "インタビューを始める" }));
    await waitFor(() => expect(uploadContextFile).toHaveBeenCalledTimes(2));
    // join 済みトークン（session_token）で投入する（契約 §4）。
    expect(uploadContextFile.mock.calls[0][2]).toBe("st");
    expect((uploadContextFile.mock.calls[0][1] as File).name).toBe("PRD.png");
    // 03-0 開始前サマリの「参考資料」に名前＋件数が出る（固定文の置換 / 監査 B-2 #11）。
    await waitFor(() => expect(screen.getByText("支度、相整いまして")).toBeTruthy());
    expect(screen.getByText(/PRD\.png ・ 他1件/)).toBeTruthy();
    expect(screen.getByText(/（計2件）/)).toBeTruthy();
  });

  it("1 件の投入失敗でも会話開始は止めない（残りは 05 で再投入できる）", async () => {
    const { container } = gotoPrepare();
    fireEvent.click(screen.getByRole("checkbox"));
    uploadContextFile.mockRejectedValueOnce(new Error("upload failed: 500"));
    pickFiles(container, [new File(["x"], "ng.png", { type: "image/png" })]);
    fireEvent.click(screen.getByRole("button", { name: "インタビューを始める" }));
    // 失敗しても開始前サマリ（03-0）へ進む。
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
