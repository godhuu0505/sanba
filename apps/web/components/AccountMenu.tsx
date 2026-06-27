"use client";

// ホーム/管理画面の右上アカウントメニュー（Figma 正本 13 `104:2` / 14 `106:2`）。
// アバター押下で scrim 付きドロップダウンを開き、ログイン後の導線（管理者画面・ログアウト）を
// ここに集約する（監査 docs/design/figma-implementation-audit.md B-1 #1/#5）。
// scrim は ChoicePin と同じ暗幕パターンを踏襲。認可（管理者判定）は API 側 ADMIN_EMAILS が源泉で、
// ここは導線のみ。アカウント設定の遷移先は未実装のため項目を出さない（別 issue）。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Avatar, Divider } from "@/components/sanba";
import { useGoogleAuth } from "@/lib/auth";

export interface AccountMenuProps {
  /** 管理画面では「管理者画面」項目を畳む（現在地への自己リンクを避ける）。 */
  hideAdmin?: boolean;
}

export function AccountMenu({ hideAdmin }: AccountMenuProps) {
  const { profile, signOut } = useGoogleAuth();
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

  // ログアウトはアカウントメニューに一本化。dev モードは authGate が素通しのため、
  // signOut だけでは保護ページに留まる。明示的に /login へ送ってゴール（14）を見せる。
  function handleLogout() {
    setOpen(false);
    signOut();
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
        className="flex size-[44px] items-center justify-center rounded-full text-[var(--sanba-cream)] transition-colors hover:bg-[var(--sanba-surface)]"
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
            className="fixed inset-0 z-40 bg-black/55"
          />
          <div
            role="menu"
            aria-label="アカウント"
            className="absolute right-0 top-[calc(100%+8px)] z-50 flex w-[220px] flex-col gap-[6px] rounded-[14px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] p-[8px] shadow-lg"
          >
            <p className="truncate px-[10px] pt-[4px] text-[12px] text-[var(--sanba-muted)]">
              ✅ ログイン中: <span className="text-[var(--sanba-cream)]">{email}</span>
            </p>
            <Divider />
            {!hideAdmin && (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-[14px] text-[var(--sanba-cream)] transition-colors hover:bg-[var(--sanba-bg)]"
              >
                <span aria-hidden="true">🛠</span> 管理者画面
              </Link>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-left text-[14px] text-[var(--sanba-cream)] transition-colors hover:bg-[var(--sanba-bg)]"
            >
              <span aria-hidden="true">⎋</span> ログアウト
            </button>
          </div>
        </>
      )}
    </div>
  );
}
