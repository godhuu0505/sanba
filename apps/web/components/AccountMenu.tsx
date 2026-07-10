"use client";

import { CircleCheck, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Avatar, Divider } from "@/components/sanba";
import { useAuth, type GoogleProfile } from "@/lib/auth";

export interface AccountMenuProps {
  profile: GoogleProfile | null;
  hideSettings?: boolean;
}

export function AccountMenu({ profile, hideSettings }: AccountMenuProps) {
  const router = useRouter();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const email = profile?.email ?? null;
  const glyph = (profile?.name || profile?.email || "客").trim().charAt(0) || "客";

  async function handleLogout() {
    setOpen(false);
    await signOut();
    router.replace("/login");
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
        <Avatar tone="user" glyph={glyph} size={34} imageUrl={profile?.picture} alt="" />
      </button>

      {open && (
        <>
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
            {email ? (
              <p className="truncate px-[10px] pt-[4px] text-[12px] text-sanba-muted">
                <CircleCheck size={13} aria-hidden className="mr-1 inline-block align-[-2px]" />
                ログイン中: <span className="text-sanba-cream">{email}</span>
              </p>
            ) : (
              <p className="truncate px-[10px] pt-[4px] text-[12px] text-sanba-muted">
                アカウント情報を取得できません
              </p>
            )}
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
