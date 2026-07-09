"use client";

import { ChevronLeft, Home, Menu, Package, PanelLeftClose, PanelLeftOpen, ScrollText } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Logo } from "@/components/sanba";
import { useAuthOptional } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { SidebarAccount } from "./SidebarAccount";

export type AppNavKey = "home" | "results" | "products";

interface NavItem {
  key: AppNavKey;
  href: string;
  label: string;
  Icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { key: "home", href: "/", label: "ホーム", Icon: Home },
  { key: "results", href: "/results", label: "過去の要件一覧", Icon: ScrollText },
  { key: "products", href: "/products", label: "アプリ管理", Icon: Package },
];

const HIDDEN_KEY = "sanba.sidebar.hidden";

export interface AppShellProps {
  current?: AppNavKey;
  title?: React.ReactNode;
  onBack?: () => void;
  headerRight?: React.ReactNode;
  mainClassName?: string;
  children: React.ReactNode;
}

function SidebarBody({
  current,
  onNavigate,
}: {
  current?: AppNavKey;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="サイドメニュー" className="flex flex-1 flex-col gap-[4px]">
      {NAV_ITEMS.map(({ key, href, label, Icon }) => {
        const isCurrent = current === key;
        return (
          <Link
            key={key}
            href={href}
            aria-current={isCurrent ? "page" : undefined}
            aria-label={label}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-[10px] rounded-[10px] px-[12px] py-[10px] text-[14px] font-bold transition-colors",
              isCurrent
                ? "bg-sanba-gold-pale text-sanba-gold-text"
                : "text-sanba-cream hover:bg-sanba-bg",
            )}
          >
            <Icon size={18} aria-hidden className="shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="mb-[10px] flex h-[44px] items-center justify-between px-[6px]">
      <Link href="/" aria-label="SANBA ホーム" className="flex items-center">
        <Logo size="md" />
      </Link>
      <button
        type="button"
        onClick={onClose}
        aria-label="サイドメニューを閉じる"
        aria-expanded
        title="サイドメニューを閉じる"
        className="flex size-[32px] items-center justify-center rounded-[8px] text-sanba-muted transition-colors hover:bg-sanba-bg hover:text-sanba-cream"
      >
        <PanelLeftClose size={18} aria-hidden />
      </button>
    </div>
  );
}

export function AppShell({
  current,
  title,
  onBack,
  headerRight,
  mainClassName,
  children,
}: AppShellProps) {
  const auth = useAuthOptional();
  const [open, setOpen] = React.useState(true);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(HIDDEN_KEY) === "1") setOpen(false);
    } catch {}
  }, []);

  const setOpenPersist = React.useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(HIDDEN_KEY, next ? "0" : "1");
    } catch {}
  }, []);

  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="sanba-screen-bg sanba-font flex min-h-dvh w-full text-sanba-cream">
      {open && (
        <aside className="hidden w-[248px] shrink-0 flex-col border-r border-sanba-border bg-sanba-surface-strong p-[12px] lg:flex">
          <SidebarHeader onClose={() => setOpenPersist(false)} />
          <SidebarBody current={current} />
          {auth && <SidebarAccount profile={auth.profile} />}
        </aside>
      )}

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            aria-label="閉じる（背景）"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-sanba-frame/55"
          />
          <aside
            aria-label="サイドメニュー"
            className="sanba-drawer-in relative z-10 flex w-[264px] max-w-[82%] flex-col border-r border-sanba-border bg-sanba-surface-strong p-[12px] shadow-lg"
          >
            <SidebarHeader onClose={() => setMobileOpen(false)} />
            <SidebarBody current={current} onNavigate={() => setMobileOpen(false)} />
            {auth && <SidebarAccount profile={auth.profile} />}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-[10px] border-b border-sanba-border-strong bg-sanba-surface-strong px-[14px]">
          {!open && (
            <div className="hidden items-center gap-[8px] lg:flex">
              <button
                type="button"
                onClick={() => setOpenPersist(true)}
                aria-label="サイドメニューを開く"
                aria-expanded={false}
                title="サイドメニューを開く"
                className="flex size-[36px] items-center justify-center rounded-[10px] text-sanba-cream transition-colors hover:bg-sanba-bg"
              >
                <PanelLeftOpen size={19} aria-hidden />
              </button>
              <Link href="/" aria-label="SANBA ホーム" className="flex items-center">
                <Logo size="sm" wordmark={false} />
              </Link>
            </div>
          )}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="戻る"
              className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] border-[1.5px] border-sanba-frame bg-sanba-surface text-sanba-cream transition-[box-shadow,transform] hover:shadow-[2px_2px_0_var(--sanba-shadow)]"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
          )}
          <Link href="/" aria-label="SANBA ホーム" className="flex items-center lg:hidden">
            <Logo size="sm" wordmark={false} />
          </Link>
          {title != null && title !== "" && (
            <h1 className="truncate text-[15px] font-bold text-sanba-cream">{title}</h1>
          )}
          <div className="ml-auto flex items-center gap-[8px]">
            {headerRight}
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={mobileOpen}
              aria-label="メニューを開く"
              onClick={() => setMobileOpen(true)}
              className="flex size-[36px] items-center justify-center rounded-[10px] text-sanba-cream transition-colors hover:bg-sanba-bg lg:hidden"
            >
              <Menu size={19} aria-hidden />
            </button>
          </div>
        </header>
        <main
          className={cn(
            "relative flex flex-1 flex-col overflow-y-auto sanba-scroll",
            mainClassName,
          )}
        >
          <div key={current} className="sanba-page-enter flex flex-1 flex-col">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
