"use client";

// アプリ全体の外枠（ヘッダー＋サイドメニュー＋本文）。SaaS の定番構成に倣い、
// 遷移導線をサイドメニューに集約する（要望 2026-07「基本はサイドメニューから遷移」）。
//  - PC（lg 以上）: サイドメニューを常時表示。開閉でき、閉じるとアイコン（lucide）のみの
//    レール表示になる。開閉状態は localStorage に保つ（再訪時も維持）。
//  - スマホ（lg 未満）: 常時表示は場所を食うため、ヘッダーのハンバーガーで開く
//    オフキャンバス・ドロワー（scrim 付き）にする。項目/背景/Escape で閉じる。
// 現在地の強調は current で受ける（ホームフローは History API で URL だけ書き換わり
// ルート遷移しないため、usePathname では追随できない）。認可は遷移先 API が源泉で、
// ここは導線のみ（SideMenu 踏襲）。

import {
  ChevronLeft,
  Home,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  X,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Logo } from "@/components/sanba";
import { cn } from "@/lib/utils";

/** 現在地。自己リンクは aria-current を付け、押しても混乱しないよう強調表示にする。 */
export type AppNavKey = "home" | "results" | "products";

interface NavItem {
  key: AppNavKey;
  href: string;
  label: string;
  Icon: LucideIcon;
}

// サイドメニューの遷移項目。ホーム・過去の要件一覧・アプリ管理をここに集約する
//（要望: 過去のセッションとアプリ管理をサイドメニューへ移す／過去の要件一覧への導線を置く）。
const NAV_ITEMS: NavItem[] = [
  { key: "home", href: "/", label: "ホーム", Icon: Home },
  { key: "results", href: "/results", label: "過去の要件一覧", Icon: ScrollText },
  { key: "products", href: "/products", label: "アプリ管理", Icon: Package },
];

const COLLAPSE_KEY = "sanba.sidebar.collapsed";

export interface AppShellProps {
  /** 現在表示中の画面。該当ナビ項目を現在地として強調する。 */
  current?: AppNavKey;
  /** ヘッダーの見出し（画面名）。 */
  title?: React.ReactNode;
  /** 戻る導線。渡すとヘッダー左に戻るボタンを出す。 */
  onBack?: () => void;
  /** ヘッダー右のスロット（アカウントメニュー等）。 */
  headerRight?: React.ReactNode;
  /** 本文の追加クラス（縦中央寄せなど画面ごとのレイアウト調整に使う）。 */
  mainClassName?: string;
  children: React.ReactNode;
}

// サイドメニューの中身（ロゴ＋遷移項目）。PC の常時表示とスマホのドロワーで共有する。
// collapsed=true はアイコンのみのレール表示。onNavigate は項目押下時に呼ぶ（スマホは閉じる）。
function SidebarBody({
  current,
  collapsed,
  onNavigate,
}: {
  current?: AppNavKey;
  collapsed: boolean;
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
            title={collapsed ? label : undefined}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-[10px] rounded-[10px] px-[12px] py-[10px] text-[14px] font-bold transition-colors",
              collapsed && "justify-center px-0",
              isCurrent
                ? "bg-sanba-gold-pale text-sanba-gold-text"
                : "text-sanba-cream hover:bg-sanba-bg",
            )}
          >
            <Icon size={18} aria-hidden className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </Link>
        );
      })}
    </nav>
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
  // PC のレール折りたたみ（アイコンのみ）。既定は展開（要望「デフォルトは常に表示」）。
  // SSR とハイドレーション不一致を避けるため、初期は false で描画し、マウント後に復元する。
  const [collapsed, setCollapsed] = React.useState(false);
  // スマホのドロワー開閉。既定は閉じ（ハンバーガーで開く）。
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
    } catch {
      // localStorage 不可（プライベートブラウズ等）は既定の展開のまま。
    }
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // 保存できなくても表示は切り替える（永続化は副次）。
      }
      return next;
    });
  }, []);

  // Escape でドロワーを閉じる（a11y / AccountMenu と同じ）。開いている間だけ購読する。
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
      {/* ── PC: 常時表示のサイドメニュー（開閉でアイコンのみのレールへ）─────────── */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-sanba-border bg-sanba-surface-strong p-[12px] transition-[width] duration-200 ease-out lg:flex",
          collapsed ? "w-[72px]" : "w-[248px]",
        )}
      >
        <div
          className={cn(
            "mb-[10px] flex h-[44px] items-center",
            collapsed ? "justify-center" : "px-[6px]",
          )}
        >
          <Link href="/" aria-label="SANBA ホーム" className="flex items-center">
            <Logo size="md" wordmark={!collapsed} />
          </Link>
        </div>
        <SidebarBody current={current} collapsed={collapsed} />
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "サイドメニューを開く" : "サイドメニューを閉じる"}
          aria-expanded={!collapsed}
          title={collapsed ? "サイドメニューを開く" : "サイドメニューを閉じる"}
          className={cn(
            "mt-[8px] flex items-center gap-[10px] rounded-[10px] px-[12px] py-[10px] text-[13px] font-bold text-sanba-muted transition-colors hover:bg-sanba-bg hover:text-sanba-cream",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} aria-hidden className="shrink-0" />
          ) : (
            <>
              <PanelLeftClose size={18} aria-hidden className="shrink-0" />
              <span>折りたたむ</span>
            </>
          )}
        </button>
      </aside>

      {/* ── スマホ: オフキャンバス・ドロワー（scrim 付き）──────────────────────── */}
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
            <div className="mb-[10px] flex h-[44px] items-center justify-between px-[6px]">
              <Logo size="md" />
              <button
                type="button"
                aria-label="メニューを閉じる"
                onClick={() => setMobileOpen(false)}
                className="flex size-[32px] items-center justify-center rounded-[8px] text-sanba-muted transition-colors hover:bg-sanba-bg hover:text-sanba-cream"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <SidebarBody
              current={current}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      {/* ── 本文カラム（ヘッダー＋スクロールする本文）──────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-[10px] border-b border-sanba-border-strong bg-sanba-surface-strong px-[14px]">
          {/* スマホはサイドメニューが隠れるためハンバーガーを出す（PC は常時表示なので不要）。 */}
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
          {/* スマホはサイドメニューのロゴが隠れるため、ヘッダーにブランドを添える。 */}
          <Link href="/" aria-label="SANBA ホーム" className="flex items-center lg:hidden">
            <Logo size="sm" wordmark={false} />
          </Link>
          {title != null && title !== "" && (
            <h1 className="truncate text-[15px] font-bold text-sanba-cream">{title}</h1>
          )}
          {headerRight != null && (
            <div className="ml-auto flex items-center">{headerRight}</div>
          )}
        </header>
        <main
          className={cn(
            "relative flex flex-1 flex-col overflow-y-auto sanba-scroll",
            mainClassName,
          )}
        >
          {/* ページ遷移のさりげない導入（フェード＋僅かな上げ）。current で再マウントし直す。
              flex-1 の flex 縦積みにし、本文側は mx-auto（上寄せ）や m-auto（上下中央）で寄せる。 */}
          <div key={current} className="sanba-page-enter flex flex-1 flex-col">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
