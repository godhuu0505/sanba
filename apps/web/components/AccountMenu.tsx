"use client";

// ホーム/管理画面の右上アカウントメニュー（Figma 正本 13 `104:2` / 14 `106:2`）。
// アバター押下で scrim 付きドロップダウンを開き、ログイン後の導線（管理者画面・ログアウト）を
// ここに集約する（監査 docs/notes/figma-implementation-audit.md B-1）。
// scrim は ChoicePin と同じ暗幕パターンを踏襲。認可（管理者判定）は API 側 ADMIN_EMAILS が源泉で、
// ここは導線のみ。項目順は Figma 正本（106:45）に合わせ ⚙ アカウント設定 → 🛠 管理者画面 → ⎋ ログアウト。

import { CircleCheck, LogOut, Settings, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Avatar, Divider } from "@/components/sanba";
import type { GoogleProfile } from "@/lib/auth";

export interface AccountMenuProps {
  /**
   * 表示中ユーザー。ページ側で解決済みの `useAuth().profile` を渡す（装飾目的）。
   * ここで認証 hook を直接呼ばないことで、共有インスタンスと分断された状態を作らない。
   */
  profile: GoogleProfile | null;
  /** 管理画面では「管理者画面」項目を畳む（現在地への自己リンクを避ける）。 */
  hideAdmin?: boolean;
  /** 設定画面では「アカウント設定」項目を畳む（現在地への自己リンクを避ける）。 */
  hideSettings?: boolean;
}

export function AccountMenu({ profile, hideAdmin, hideSettings }: AccountMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Escape で閉じる（a11y）。開いている間だけ購読する。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const email = profile?.email ?? "dev@sanba.local";
  // 表示用の頭文字（name → email → 既定）。装飾目的のみ。
  const glyph = (profile?.name || profile?.email || "客").trim().charAt(0) || "客";

  // ログアウトは /login?loggedOut=1 への遷移に一本化する。実際の signOut は遷移先 /login が行い、
  // 元ページでは signOut しない。こうすることで元ページの authGate が次描画で /login?next= へ
  // リダイレクトして本遷移を上書きするレースを避ける。
  function handleLogout() {
    setOpen(false);
    router.push("/login?loggedOut=1");
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="アカウントメニュー"
        onClick={() => setOpen((v) => !v)}
        className="flex size-[44px] items-center justify-center rounded-full text-sanba-cream transition-colors hover:bg-sanba-surface"
      >
        {profile?.picture ? (
          // 装飾目的（隣接でアカウント名は menu 内に出す）。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.picture}
            alt=""
            className="size-[34px] rounded-full object-cover"
          />
        ) : (
          <Avatar tone="user" glyph={glyph} size={34} />
        )}
      </button>

      {open && (
        <>
          {/* 暗幕（ChoicePin 踏襲）。クリックで閉じる。 */}
          <button
            type="button"
            aria-label="閉じる（背景）"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-sanba-frame/55"
          />
          <div
            role="menu"
            aria-label="アカウント"
            className="absolute right-0 top-[calc(100%+8px)] z-50 flex w-[220px] flex-col gap-[6px] rounded-[14px] border border-sanba-border bg-sanba-surface p-[8px] shadow-lg"
          >
            <p className="truncate px-[10px] pt-[4px] text-[12px] text-sanba-muted">
              <CircleCheck size={13} aria-hidden className="mr-1 inline-block align-[-2px]" />
              ログイン中: <span className="text-sanba-cream">{email}</span>
            </p>
            <Divider />
            {!hideSettings && (
              <Link
                href="/settings"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-[14px] text-sanba-cream transition-colors hover:bg-sanba-bg"
              >
                <Settings size={16} aria-hidden /> アカウント設定
              </Link>
            )}
            {!hideAdmin && (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-[14px] text-sanba-cream transition-colors hover:bg-sanba-bg"
              >
                <Wrench size={16} aria-hidden /> 管理者画面
              </Link>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-left text-[14px] text-sanba-cream transition-colors hover:bg-sanba-bg"
            >
              <LogOut size={16} aria-hidden /> ログアウト
            </button>
          </div>
        </>
      )}
    </div>
  );
}
