"use client";

// アカウント設定画面「設えの間」（Figma 正本 14 アカウントメニュー `106:45` の ⚙ アカウント設定 の遷移先 / #227）。
// 最低限の項目（プロフィール表示・データ保持日数・ログアウト）を SANBA デザインシステム（components/sanba/*）の
// 金彩テーマで提供する。Figma に専用の設定画面ノードは無いため、メニューの世界観に揃えた最小構成とする。
//
// 認可・認証ロジックは不変（CLAUDE.md「スキン」方針）。保持日数は表示のみ（実バックエンド変更は範囲外 / 別 issue）。
// 認証ゲート配下に置き、未ログインでは露出しない（authGate → /login?next=/settings）。

import { useRouter } from "next/navigation";

import { AccountMenu } from "@/components/AccountMenu";
import { GitHubLinkCard } from "@/components/GitHubLinkCard";
import { authGate } from "@/components/RequireAuth";
import {
  AppHeader,
  Avatar,
  Button,
  Card,
  CardTitle,
  Divider,
  Screen,
} from "@/components/sanba";
import { useAuth } from "@/lib/auth";

// 録音同意文言（app/page.tsx）と同じ既定値を参照し、表示の食い違いを防ぐ。
const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

export default function SettingsPage() {
  const auth = useAuth();
  const router = useRouter();

  // 厳密な認証ゲート（全画面保護）。未ログインは /login?next=/settings へ戻す。
  // 判定は authGate に集約（解決前・dev の扱いも含む）。
  const gate = authGate(auth, "/settings");
  if (gate) return gate;

  const profile = auth.profile;
  const name = profile?.name || "ゲスト";
  const email = profile?.email ?? "dev@sanba.local";
  // 表示用の頭文字（name → email → 既定）。装飾目的のみ（AccountMenu と同じ規則）。
  const glyph = (profile?.name || profile?.email || "客").trim().charAt(0) || "客";

  // ログアウトは AccountMenu と同じく /login?loggedOut=1 への遷移に一本化する。
  // 実際の signOut は遷移先 /login が行う（元ページの authGate が本遷移を上書きするレースを避ける）。
  function handleLogout() {
    router.push("/login?loggedOut=1");
  }

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader
        title="アカウント設定"
        onBack={() => router.push("/")}
        right={<AccountMenu profile={profile} hideSettings />}
      />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {/* プロフィール表示（装飾目的。認証の真偽は API 側が源泉）。 */}
        <Card>
          <CardTitle>プロフィール</CardTitle>
          <div className="flex items-center gap-[12px]">
            {profile?.picture ? (
              // 装飾目的（隣にテキストで名前/メールを併記）。
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
              <span className="truncate text-[15px] font-bold text-[var(--sanba-cream)]">
                {name}
              </span>
              <span className="truncate text-[12px] text-[var(--sanba-muted)]">{email}</span>
            </div>
          </div>
        </Card>

        {/* データの取り扱い（保持日数）。表示のみ（実バックエンド変更は範囲外 / #227）。 */}
        <Card>
          <CardTitle>データの取り扱い</CardTitle>
          <dl className="flex flex-col gap-[6px]">
            <div className="flex items-baseline justify-between gap-[12px]">
              <dt className="text-[13px] text-[var(--sanba-muted)]">保持日数</dt>
              <dd className="text-[14px] font-bold text-[var(--sanba-gold-text)]">
                最大 {RETENTION_DAYS} 日
              </dd>
            </div>
          </dl>
          <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
            録音と要件は最大 {RETENTION_DAYS} 日保持し、保存前に個人情報をマスクします。
          </p>
        </Card>

        {/* GitHub 連携（ADR-0025 / 仕様①）。連携アカウントの repo を準備画面で前提化できる。 */}
        <GitHubLinkCard />

        {/* ログアウト導線（アカウントメニューと同じ遷移先に一本化）。 */}
        <Card>
          <CardTitle>セッション</CardTitle>
          <Divider />
          <Button variant="outline" block onClick={handleLogout} aria-label="ログアウト">
            ⎋ ログアウト
          </Button>
        </Card>
      </main>
    </Screen>
  );
}
