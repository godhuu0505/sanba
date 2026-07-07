"use client";

import { Home, Menu, Package, ScrollText, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type SideMenuCurrent = "home" | "results" | "products";

export interface SideMenuProps {
  current?: SideMenuCurrent;
}

const ITEMS: { key: SideMenuCurrent; href: string; label: string; Icon: LucideIcon }[] = [
  { key: "home", href: "/", label: "ホーム", Icon: Home },
  { key: "results", href: "/results", label: "過去の要件一覧", Icon: ScrollText },
  { key: "products", href: "/products", label: "アプリ管理", Icon: Package },
];

export function SideMenu({ current }: SideMenuProps) {
  const [open, setOpen] = useState(false);

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
