"use client";

import { CircleCheck, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Avatar, Divider } from "@/components/sanba";
import type { GoogleProfile } from "@/lib/auth";
import { cn } from "@/lib/utils";

export interface SidebarAccountProps {
  profile: GoogleProfile | null;
  collapsed?: boolean;
}

export function SidebarAccount({ profile, collapsed = false }: SidebarAccountProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const email = profile?.email ?? "dev@sanba.local";
  const name = profile?.name?.trim() || email;
  const glyph = (profile?.name || profile?.email || "客").trim().charAt(0) || "客";

  function handleLogout() {
    setOpen(false);
    router.push("/login?loggedOut=1");
  }

  return (
    <div className="relative mt-[8px] border-t border-sanba-border pt-[8px]">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="アカウントメニュー"
        title={collapsed ? name : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-[10px] rounded-[10px] px-[10px] py-[8px] text-left transition-colors hover:bg-sanba-bg",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar
          tone="user"
          glyph={glyph}
          size={32}
          imageUrl={profile?.picture}
          alt=""
        />
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold text-sanba-cream">{name}</span>
            <span className="block truncate text-[11px] text-sanba-muted">{email}</span>
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="アカウントメニューを閉じる（背景）"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-sanba-frame/55"
          />
          <div
            role="menu"
            aria-label="アカウント"
            className="absolute bottom-[calc(100%+8px)] left-0 z-50 flex w-[220px] flex-col gap-[6px] rounded-[14px] border border-sanba-border bg-sanba-surface p-[8px] shadow-lg"
          >
            <p className="truncate px-[10px] pt-[4px] text-[12px] text-sanba-muted">
              <CircleCheck size={13} aria-hidden className="mr-1 inline-block align-[-2px]" />
              ログイン中: <span className="text-sanba-cream">{email}</span>
            </p>
            <Divider />
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-[8px] rounded-[10px] px-[10px] py-[10px] text-[14px] text-sanba-cream transition-colors hover:bg-sanba-bg"
            >
              <Settings size={16} aria-hidden /> アカウント設定
            </Link>
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
