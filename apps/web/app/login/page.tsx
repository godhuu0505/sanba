"use client";

// ログイン画面 (ADR-0014 §1)。既存の Google OIDC (GIS) を画面化しただけで、認証基盤は
// 追加していない。ログイン後はインタビュー (/) と管理画面 (/admin) への導線を出す。
// 管理者かどうかは API 側 (ADMIN_EMAILS) が源泉なので、ここでは判定しない (§2,§7)。

import Link from "next/link";

import { useGoogleAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  const auth = useGoogleAuth();
  const { loggedIn, profile, devMode, buttonRef, devSignIn, signOut } = auth;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle>🎙️ SANBA にログイン</CardTitle>
          <CardDescription>
            解像度高く、要件を生み出す音声マルチエージェント。Google アカウントで本人確認します。
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {loggedIn ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                ✅ ログイン中:{" "}
                <strong>{profile?.email ?? "dev@sanba.local"}</strong>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href="/">インタビューを始める</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/admin">管理画面</Link>
                </Button>
              </div>
            </div>
          ) : devMode ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                開発モード（GOOGLE_CLIENT_ID 未設定）。
              </p>
              <Button onClick={devSignIn}>開発用ログイン（bypass）</Button>
            </div>
          ) : (
            // GIS がこの div にログインボタンを描画する。
            <div ref={buttonRef} />
          )}
        </CardContent>

        {loggedIn && (
          <CardFooter>
            <Button variant="ghost" size="sm" onClick={signOut}>
              ログアウト
            </Button>
          </CardFooter>
        )}
      </Card>
    </main>
  );
}
