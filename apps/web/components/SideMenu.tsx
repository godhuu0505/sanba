"use client";

// サイドメニュー。トップ（ホーム）・セッション準備・セッション結果の各画面から
// アプリ管理（/products）などへ横断遷移する導線を 1 か所に集約する。
// ハンバーガー押下で scrim 付きの左ドロワーを開く（scrim・Escape 閉じは AccountMenu 踏襲）。
// 認可（アプリ管理の owner 判定等）は遷移先の API が源泉で、ここは導線のみ。

import { AppWindow, ClipboardList, Home, Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

/** 現在地。自己リンクは aria-current を付け、押しても混乱しないよう強調表示にする。 */
export type SideMenuCurrent = "home" | "prepare" | "products";

export interface SideMenuProps {
  /** 表示中の画面（該当項目を現在地として強調する）。結果画面などは未指定でよい。 */
  current?: SideMenuCurrent;
}

const ITEMS: { key: SideMenuCurrent; href: string; label: string; Icon: LucideIcon }[] = [
  { key: "home", href: "/", label: "ホーム", Icon: Home },
  { key: "prepare", href: "/prepare", label: "セッション準備", Icon: ClipboardList },
  { key: "products", href: "/products", label: "アプリ管理", Icon: AppWindow },
];

export function SideMenu({ current }: SideMenuProps) {
  const [open, setOpen] = useState(false);

  // Escape で閉じる（a11y / AccountMenu と同じ）。開いている間だけ購読する。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="サイドメニュー"
        onClick={() => setOpen((v) => !v)}
        className="flex size-[36px] items-center justify-center rounded-[10px] text-sanba-cream transition-colors hover:bg-sanba-surface"
      >
        <Menu size={19} aria-hidden />
      </button>

      {open && (
        <>
          {/* 暗幕（AccountMenu / ChoicePin 踏襲）。クリックで閉じる。 */}
          <button
            type="button"
            aria-label="閉じる（背景）"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-sanba-frame/55"
          />
          <nav
            role="menu"
            aria-label="サイドメニュー"
            className="fixed inset-y-0 left-0 z-50 flex w-[240px] flex-col gap-[6px] border-r border-sanba-border bg-sanba-surface p-[12px] shadow-lg"
          >
            <div className="flex items-center justify-between px-[6px] pb-[4px] pt-[2px]">
              <p className="text-[12px] font-bold text-sanba-muted">メニュー</p>
              <button
                type="button"
                aria-label="サイドメニューを閉じる"
                onClick={() => setOpen(false)}
                className="flex size-[28px] items-center justify-center rounded-[8px] text-sanba-muted transition-colors hover:bg-sanba-bg hover:text-sanba-cream"
              >
                <X size={15} aria-hidden />
              </button>
            </div>
            {ITEMS.map(({ key, href, label, Icon }) => {
              const isCurrent = current === key;
              return (
                <Link
                  key={key}
                  href={href}
                  role="menuitem"
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-[14px] transition-colors hover:bg-sanba-bg ${
                    isCurrent ? "bg-sanba-bg font-bold text-sanba-gold-text" : "text-sanba-cream"
                  }`}
                >
                  <Icon size={16} aria-hidden /> {label}
                </Link>
              );
            })}
          </nav>
        </>
      )}
    </>
  );
}
