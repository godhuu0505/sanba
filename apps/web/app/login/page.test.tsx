// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import { AuthProvider } from "@/lib/auth";
import LoginPage from "./page";

// LoginPage は useAuth() で共有 auth を読むため、AuthProvider 配下で描画する。
const renderLogin = () => render(<LoginPage />, { wrapper: AuthProvider });

// dev モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定）では GIS 無しに全フローを駆動できる。
// 12（本人確認中）の自動遷移はフェイクタイマーで進める。13 ナビハブは廃止し、ログイン後は
// ホーム（or ?next）へ replace する。ログアウト挨拶（14）は ?loggedOut=1 で出す。
describe("LoginPage ログイン/ログアウト フロー（dev モード）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
    replace.mockClear();
    window.history.replaceState({}, "", "/login");
  });

  it("11 → 12 → ログイン後はホーム / へ送る（13 ナビハブは無い）", () => {
    renderLogin();

    // 11 未認証（「問答の間へ、ようこそ」は常時表示の左ペインへ移したため、
    // 状態 11 の判定は右メインの「サインイン」見出しで行う）。
    expect(screen.getByRole("heading", { name: "サインイン" })).toBeTruthy();
    const bypass = screen.getByText("開発用ログイン（bypass）");

    // 11 → 12 サインイン中
    act(() => {
      fireEvent.click(bypass);
    });
    expect(screen.getByText("Google アカウントを確認しています")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();

    // 12 →（タイマー経過で）ホーム / へ遷移。導線カード（13）は出さない。
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(replace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("ようこそ戻られました")).toBeNull();
  });

  it("?next= 付きで来てログインすると、welcome 後に元の遷移先へ復帰する", () => {
    window.history.replaceState({}, "", "/login?next=%2F%E5%95%8F%E7%AD%94");
    renderLogin();
    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    // welcome 中はまだ復帰しない
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(replace).toHaveBeenCalledWith("/問答");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"])(
    "オリジン外/危険スキームの next=%s は破棄し、既定のホーム / へ送る（オープンリダイレクト/XSS 防止）",
    (evil) => {
      window.history.replaceState({}, "", `/login?next=${encodeURIComponent(evil)}`);
      renderLogin();
      act(() => {
        fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
      });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      // 危険な next は無視され、evil へは飛ばさず "/" に丸める。
      expect(replace).toHaveBeenCalledWith("/");
      expect(replace).not.toHaveBeenCalledWith(evil);
    },
  );

  it("?loggedOut=1 で来ると 14（おつかれさまでした）を出し、再ログインで 11 へ戻る", () => {
    window.history.replaceState({}, "", "/login?loggedOut=1");
    renderLogin();

    // 14 ログアウト完了。未ログインのままなのでホームへは送らない。
    expect(screen.getByText("おつかれさまでした")).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/");

    // 14 → 11 再ログイン
    act(() => {
      fireEvent.click(screen.getByText("再びログインする"));
    });
    expect(screen.getByRole("heading", { name: "サインイン" })).toBeTruthy();
  });

  // ── 2 ペイン構成（2026-07 整理: 左 1/3 ブランド＋サインアップ / 右 サインイン）──────

  it("11 は 2 ペイン構成: 左にブランド＋サインアップ、右メインにサインイン（メール/パスワード欄は無い）", () => {
    renderLogin();

    // 共通ヘッダー（banner）: SANBA ブランドは全画面ヘッダーに一本化（aside と二重にしない）。
    expect(within(screen.getByRole("banner")).getByText("SANBA")).toBeTruthy();

    // 左ペイン（aside = complementary）: SANBA の世界観とサインアップ導線。
    const aside = screen.getByRole("complementary");
    expect(within(aside).getByText("問答の間へ、ようこそ")).toBeTruthy();
    expect(within(aside).queryByText("SANBA")).toBeNull();
    expect(within(aside).getByRole("button", { name: "今すぐサインアップ" })).toBeTruthy();

    // 右メイン: サインイン見出しとログインボタン（dev モードでは bypass）。
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "サインイン" })).toBeTruthy();
    expect(within(main).getByText("開発用ログイン（bypass）")).toBeTruthy();

    // メール/パスワードでのログインは持たない（Google のみ / 要件）。
    expect(document.querySelector("input")).toBeNull();
  });

  it("12・14 でも共通ヘッダーと左ペイン（ブランド＋サインアップ）は残る", () => {
    window.history.replaceState({}, "", "/login?loggedOut=1");
    renderLogin();

    // 14 ログアウト完了でも SANBA ヘッダーと左ペインは出たまま。
    expect(screen.getByText("おつかれさまでした")).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText("SANBA")).toBeTruthy();
    expect(
      within(screen.getByRole("complementary")).getByRole("button", { name: "今すぐサインアップ" }),
    ).toBeTruthy();
  });

  it("「今すぐサインアップ」は右のサインイン枠へ誘導する（Google 初回サインインが登録を兼ねる）", () => {
    // jsdom は scrollIntoView 未実装のため、プロトタイプへ注入して呼び出しを観測する。
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderLogin();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "今すぐサインアップ" }));
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // 誘導先はサインイン枠＝ログインボタンのある右メイン側。
    expect(screen.getByRole("heading", { name: "サインイン" })).toBeTruthy();
  });
});
