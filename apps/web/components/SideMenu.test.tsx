// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SideMenu } from "./SideMenu";

describe("SideMenu", () => {
  afterEach(() => cleanup());

  function open() {
    fireEvent.click(screen.getByRole("button", { name: "サイドメニュー" }));
  }

  it("初期はメニューを開かない", () => {
    render(<SideMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ハンバーガー押下でホーム/セッション準備/アプリ管理の3項目を出す", () => {
    render(<SideMenu />);
    open();
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    expect(items[0]).toMatch(/ホーム/);
    expect(items[1]).toMatch(/セッション準備/);
    expect(items[2]).toMatch(/アプリ管理/);
  });

  it("アプリ管理は /products へ遷移する menuitem（要求仕様: サイドメニューから管理画面へ）", () => {
    render(<SideMenu />);
    open();
    const products = screen.getByRole("menuitem", { name: /アプリ管理/ });
    expect(products.getAttribute("href")).toBe("/products");
  });

  it("current の項目に aria-current=page を付けて現在地を示す", () => {
    render(<SideMenu current="home" />);
    open();
    expect(
      screen.getByRole("menuitem", { name: /ホーム/ }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("menuitem", { name: /アプリ管理/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("背景（scrim）クリックで閉じる", () => {
    render(<SideMenu />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("項目クリックで閉じる（遷移後にドロワーを残さない）", () => {
    render(<SideMenu />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /アプリ管理/ }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape で閉じる（a11y）", () => {
    render(<SideMenu />);
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
