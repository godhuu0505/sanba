// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell } from "./AppShell";

describe("AppShell（恒常サイドメニュー＋ヘッダー）", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("サイドメニューにホーム/過去の要件一覧/アプリ管理の遷移を出す", () => {
    render(<AppShell>本文</AppShell>);
    expect(screen.getByRole("link", { name: "ホーム" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "過去の要件一覧" }).getAttribute("href")).toBe(
      "/results",
    );
    expect(screen.getByRole("link", { name: "アプリ管理" }).getAttribute("href")).toBe(
      "/products",
    );
  });

  it("current の項目に aria-current=page を付けて現在地を示す", () => {
    render(<AppShell current="results">本文</AppShell>);
    expect(screen.getByRole("link", { name: "過去の要件一覧" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "ホーム" }).getAttribute("aria-current")).toBeNull();
  });

  it("title・headerRight・本文を描画する", () => {
    render(
      <AppShell title="過去の要件一覧" headerRight={<span>右スロット</span>}>
        <p>本文コンテンツ</p>
      </AppShell>,
    );
    expect(screen.getByRole("heading", { name: "過去の要件一覧" })).toBeTruthy();
    expect(screen.getByText("右スロット")).toBeTruthy();
    expect(screen.getByText("本文コンテンツ")).toBeTruthy();
  });

  it("onBack を渡すと戻るボタンを出し、押下で呼ぶ", () => {
    let backed = 0;
    render(
      <AppShell onBack={() => (backed += 1)}>
        本文
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(backed).toBe(1);
  });

  it("閉じるとサイドメニューを隠し、開くボタンを出して localStorage に保存する（PC）", () => {
    render(<AppShell>本文</AppShell>);
    expect(screen.getByRole("link", { name: "ホーム" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "サイドメニューを閉じる" }));
    expect(screen.queryByRole("link", { name: "ホーム" })).toBeNull();
    expect(screen.getByRole("button", { name: "サイドメニューを開く" })).toBeTruthy();
    expect(window.localStorage.getItem("sanba.sidebar.hidden")).toBe("1");
  });

  it("開くボタンで再表示し localStorage を更新する（PC）", () => {
    render(<AppShell>本文</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "サイドメニューを閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "サイドメニューを開く" }));
    expect(screen.getByRole("link", { name: "ホーム" })).toBeTruthy();
    expect(window.localStorage.getItem("sanba.sidebar.hidden")).toBe("0");
  });

  it("保存済みの非表示状態を復元する（PC）", () => {
    window.localStorage.setItem("sanba.sidebar.hidden", "1");
    render(<AppShell>本文</AppShell>);
    expect(screen.getByRole("button", { name: "サイドメニューを開く" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "ホーム" })).toBeNull();
  });

  it("スマホ: ハンバーガーでドロワーが開き、項目クリックで閉じる", () => {
    render(<AppShell>本文</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    const drawer = screen.getByRole("complementary", { name: "サイドメニュー" });
    fireEvent.click(within(drawer).getByRole("link", { name: "過去の要件一覧" }));
    expect(screen.queryByRole("complementary", { name: "サイドメニュー" })).toBeNull();
  });

  it("スマホ: 背景クリックでドロワーを閉じる", () => {
    render(<AppShell>本文</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(screen.queryByRole("complementary", { name: "サイドメニュー" })).toBeNull();
  });

  it("スマホ: Escape でドロワーを閉じる（a11y）", () => {
    render(<AppShell>本文</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "サイドメニュー" })).toBeNull();
  });
});
