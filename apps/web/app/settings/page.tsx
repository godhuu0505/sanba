"use client";

import { useRouter } from "next/navigation";

import { AccountMenu } from "@/components/AccountMenu";
import { AppShell } from "@/components/AppShell";
import { GitHubLinkCard } from "@/components/GitHubLinkCard";
import { authGate } from "@/components/RequireAuth";
import {
  Avatar,
  Button,
  Card,
  CardTitle,
  Divider,
} from "@/components/sanba";
import { useAuth } from "@/lib/auth";

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

export default function SettingsPage() {
  const auth = useAuth();
  const router = useRouter();

  const gate = authGate(auth, "/settings");
  if (gate) return gate;

  const profile = auth.profile;
  const name = profile?.name || "ゲスト";
  const email = profile?.email ?? "dev@sanba.local";
  const glyph = (profile?.name || profile?.email || "客").trim().charAt(0) || "客";

  function handleLogout() {
    router.push("/login?loggedOut=1");
  }

  return (
    <AppShell
      title="アカウント設定"
      onBack={() => router.push("/")}
      headerRight={<AccountMenu profile={profile} hideSettings />}
    >
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-[18px] px-4 py-4">
        <Card>
          <CardTitle>プロフィール</CardTitle>
          <div className="flex items-center gap-[12px]">
            {profile?.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.picture}
                alt=""
                className="size-[44px] shrink-0 rounded-full object-cover"
              />
            ) : (
              <Avatar tone="user" glyph={glyph} size={44} />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-bold text-sanba-cream">
                {name}
              </span>
              <span className="truncate text-[12px] text-sanba-muted">{email}</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>データの取り扱い</CardTitle>
          <dl className="flex flex-col gap-[6px]">
            <div className="flex items-baseline justify-between gap-[12px]">
              <dt className="text-[13px] text-sanba-muted">保持日数</dt>
              <dd className="text-[14px] font-bold text-sanba-gold-text">
                最大 {RETENTION_DAYS} 日
              </dd>
            </div>
          </dl>
          <p className="text-[12px] leading-relaxed text-sanba-muted">
            録音と要件は最大 {RETENTION_DAYS} 日保持し、保存前に個人情報をマスクします。
          </p>
        </Card>

        <GitHubLinkCard />

        <Card>
          <CardTitle>セッション</CardTitle>
          <Divider />
          <Button variant="outline" block onClick={handleLogout} aria-label="ログアウト">
            ⎋ ログアウト
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}
