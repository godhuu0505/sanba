"use client";

// 03 会話開始（開始前 / 接続 / 許可 / 失敗）。screens/03-conversation-start.md / ADR-0018。
// 準備（02）から会話フェーズ（04）へ橋渡しする専用レイアウト。接続とマイク許可を確実に取り、
// 失敗時は理由提示＋復帰導線（設定・再試行・テキスト代替）を出す。
//
// 構成: LiveKit に触れる薄いコンテナ（ConversationStart / RoomGate）と、テスト可能な
// 純プレゼン（StartIntro / ConnectingOverlay / StartFailed）に分ける。表示は古語、
// 操作の aria-label は現代語・状態はラベル＋アイコン併記（ADR-0017）。

import { LiveKitRoom, StartAudio, useConnectionState } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useState } from "react";

import { AppHeader, Button, Card, Screen } from "@/components/sanba";

import type { JoinResponse } from "../lib/api";
import { SessionView } from "./SessionView";

type StartPhase = "intro" | "entering" | "failed";

/** 失敗の種別（理由提示の出し分け）。mic=許可拒否 / connect=接続失敗。 */
export type StartFailKind = "mic" | "connect";

export interface ConversationStartProps {
  conn: JoinResponse;
  /** 02 で入力したゴール（開始前サマリに引き継ぐ）。 */
  goal: string;
  /** 02 で選んだ役割の表示名。 */
  roleLabel: string;
  /** 中断して準備（02）へ戻す。 */
  onCancel: () => void;
}

export function ConversationStart({ conn, goal, roleLabel, onCancel }: ConversationStartProps) {
  const [phase, setPhase] = useState<StartPhase>("intro");
  // 音声で始めるか（テキストで進める場合はマイク publish せず接続する）。
  const [withMic, setWithMic] = useState(true);
  const [failKind, setFailKind] = useState<StartFailKind>("connect");

  if (phase === "intro") {
    return (
      <StartIntro
        goal={goal}
        roleLabel={roleLabel}
        onStartVoice={() => {
          setWithMic(true);
          setPhase("entering");
        }}
        onStartText={() => {
          setWithMic(false);
          setPhase("entering");
        }}
        onBack={onCancel}
      />
    );
  }

  if (phase === "failed") {
    return (
      <StartFailed
        kind={failKind}
        onRetry={() => {
          setWithMic(true);
          setPhase("entering");
        }}
        onText={() => {
          setWithMic(false);
          setPhase("entering");
        }}
        onBack={onCancel}
      />
    );
  }

  // entering / live: ルームへ接続する。接続状態は RoomGate が監視し、Connected で 04 を出す。
  return (
    <LiveKitRoom
      token={conn.token}
      serverUrl={conn.livekit_url}
      connect
      audio={withMic}
      video={false}
      style={{ height: "100dvh" }}
      onError={(e) => {
        console.error("livekit connect failed", e);
        setFailKind("connect");
        setPhase("failed");
      }}
      onMediaDeviceFailure={() => {
        // マイク許可拒否・デバイス不在（03-2→03-3）。テキストで続ける導線へ。
        setFailKind("mic");
        setPhase("failed");
      }}
    >
      <RoomGate conn={conn} onCancel={onCancel} />
    </LiveKitRoom>
  );
}

/** ルーム接続が完了するまで 03-1 を出し、Connected で 04（SessionView）へ。 */
function RoomGate({ conn, onCancel }: { conn: JoinResponse; onCancel: () => void }) {
  const state = useConnectionState();
  if (state !== ConnectionState.Connected) {
    return <ConnectingOverlay state={state} onCancel={onCancel} />;
  }
  return (
    <Screen className="px-4 py-3">
      <AppHeader brand right={<StartAudio label="🔊 音声を有効に" />} />
      <main className="mx-auto w-full max-w-[640px] flex-1">
        <p className="mb-2 text-[12px] text-[var(--sanba-muted)]">
          セッション: <code>{conn.session_id}</code>
        </p>
        <SessionView sessionId={conn.session_id} sessionToken={conn.session_token} />
      </main>
    </Screen>
  );
}

// ── 純プレゼン（テスト可能・LiveKit 非依存）─────────────────────────────────

export interface StartIntroProps {
  goal: string;
  roleLabel: string;
  onStartVoice: () => void;
  onStartText: () => void;
  onBack: () => void;
}

/** 03-0 開始前。準備サマリ＋マイク注記（OS プロンプト前の理由提示）＋開始導線。 */
export function StartIntro({ goal, roleLabel, onStartVoice, onStartText, onBack }: StartIntroProps) {
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="支度、相整いまして" onBack={onBack} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        <div className="flex flex-col items-center gap-2 pt-4">
          <div
            aria-hidden="true"
            className="sanba-gold-gradient flex size-20 items-center justify-center rounded-full text-[30px]"
          >
            産
          </div>
          <p className="text-[13px] text-[var(--sanba-muted)]">問答を始める支度が整いました。</p>
        </div>

        <Card>
          <dl className="flex flex-col gap-[10px] text-[13px]">
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-[var(--sanba-muted)]">ゴール</dt>
              <dd className="text-[var(--sanba-cream)]">{goal.trim() || "（未入力）"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-[var(--sanba-muted)]">役割</dt>
              <dd className="text-[var(--sanba-cream)]">{roleLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-[var(--sanba-muted)]">参考資料</dt>
              <dd className="text-[var(--sanba-muted)]">会話中に追加できます</dd>
            </div>
          </dl>
        </Card>

        {/* OS プロンプトの前にマイク使用の理由を提示する（03 AC）。 */}
        <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
          🎙 音声で問答するためマイクを使用します。次の画面で許可を求めます。
        </p>

        <div className="mt-1 flex flex-col gap-[8px]">
          <Button variant="gold" size="lg" block onClick={onStartVoice} aria-label="音声で会話を始める">
            🎙 問答を始める
          </Button>
          <Button variant="ghost" block onClick={onStartText} aria-label="音声を使わずテキストで進める">
            テキストで進める
          </Button>
        </div>
      </main>
    </Screen>
  );
}

export interface ConnectingOverlayProps {
  state: ConnectionState;
  onCancel: () => void;
}

/** 03-1 接続中。ルーム参加〜音声確立〜SANBA 起動待機のステップを出し、キャンセル可能。 */
export function ConnectingOverlay({ state, onCancel }: ConnectingOverlayProps) {
  // ルーム参加は SignalConnected 以降で済む。実用上は Connecting=参加中、Reconnecting=再接続。
  const joined = state === ConnectionState.Connected || state === ConnectionState.Reconnecting;
  const reconnecting = state === ConnectionState.Reconnecting;
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="繋いでおります" />
      <main className="mx-auto flex w-full max-w-[420px] flex-1 flex-col items-center gap-6 pt-12">
        <div
          aria-hidden="true"
          className="sanba-gold-gradient flex size-20 animate-pulse items-center justify-center rounded-full text-[30px]"
        >
          産
        </div>
        <p className="text-[14px] font-bold text-[var(--sanba-gold-text)]" aria-live="polite">
          {reconnecting ? "繋ぎ直しております…" : "繋いでおります…"}
        </p>
        <ul className="flex w-full flex-col gap-2 text-[13px]">
          <Step done={joined} label="ルームに参加" />
          <Step done={false} active label="音声を確立中" />
          <Step done={false} label="SANBA の起動を待機" />
        </ul>
        <div className="flex-1" />
        <Button variant="ghost" block onClick={onCancel} aria-label="接続を中断して戻る">
          キャンセル
        </Button>
      </main>
    </Screen>
  );
}

function Step({ done, active, label }: { done: boolean; active?: boolean; label: string }) {
  const icon = done ? "✓" : active ? "◌" : "・";
  const tone = done
    ? "var(--sanba-gold-text)"
    : active
      ? "var(--sanba-cream)"
      : "var(--sanba-muted)";
  return (
    <li className="flex items-center gap-2" style={{ color: tone }}>
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </li>
  );
}

export interface StartFailedProps {
  kind: StartFailKind;
  onRetry: () => void;
  onText: () => void;
  onBack: () => void;
}

/** 03-3 失敗系。原因提示＋3導線（設定で許可・再試行・テキストで続ける）。 */
export function StartFailed({ kind, onRetry, onText, onBack }: StartFailedProps) {
  const isMic = kind === "mic";
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="会話を始められませんでした" onBack={onBack} />
      <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col items-center gap-5 pt-12">
        <div
          aria-hidden="true"
          className="flex size-20 items-center justify-center rounded-full text-[32px] font-bold"
          style={{ backgroundColor: "#241216", border: "2px solid #d2564b", color: "#d2564b" }}
        >
          ⚠
        </div>
        <p className="text-[16px] font-bold text-[#e0857c]">
          {isMic ? "声を捉えられませなんだ" : "繋ぐことが叶いませなんだ"}
        </p>
        <div className="w-full rounded-[14px] border border-[#7a3a36] bg-[#241216] p-[14px] text-[12.5px] leading-relaxed text-[var(--sanba-muted)]">
          {isMic ? (
            <ul className="list-disc pl-4">
              <li>ブラウザのマイク許可が拒否されています。</li>
              <li>他のアプリがマイクを使用中の可能性があります。</li>
            </ul>
          ) : (
            <ul className="list-disc pl-4">
              <li>ネットワークが不安定か、接続がタイムアウトしました。</li>
              <li>時間をおいてもう一度お試しください。</li>
            </ul>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex w-full flex-col gap-[8px]">
          {isMic && (
            <p className="text-center text-[11.5px] text-[var(--sanba-muted)]">
              ブラウザ設定の「マイク」を許可に変えてから、もう一度お試しください。
            </p>
          )}
          <Button variant="gold" size="lg" block onClick={onRetry} aria-label="もう一度接続を試す">
            もう一度試す
          </Button>
          <Button variant="ghost" block onClick={onText} aria-label="音声を使わずテキストで続ける">
            テキストで続ける
          </Button>
        </div>
      </main>
    </Screen>
  );
}
