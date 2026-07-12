"use client";

import { LiveKitRoom, StartAudio, useConnectionState } from "@livekit/components-react";
import { ConnectionState, type RoomOptions } from "livekit-client";
import { Check, Circle, Info, LoaderCircle, Lock, Mic, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { AppHeader, Button, Card, Figure, Screen } from "@/components/sanba";

import type { JoinResponse } from "../lib/api";
import { SessionView } from "./SessionView";

const MIC_CONSTRAINTS = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
} satisfies MediaTrackConstraints;

const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: MIC_CONSTRAINTS,
};

const MIC_ERROR_NAMES = new Set([
  "NotAllowedError",
  "PermissionDeniedError",
  "NotFoundError",
  "NotReadableError",
  "OverconstrainedError",
  "SecurityError",
  "AbortError",
]);

function classifyStartError(error: unknown): StartFailKind {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && MIC_ERROR_NAMES.has(name) ? "mic" : "connect";
}

type StartPhase = "intro" | "permission" | "entering" | "failed";

export type StartFailKind = "mic" | "connect";

export interface ConversationStartProps {
  conn: JoinResponse;
  goal: string;
  roleLabel: string;
  materialNames?: string[];
  materialFailedCount?: number;
  readOnly?: boolean;
  onCancel: () => void;
}

export function ConversationStart({
  conn,
  goal,
  roleLabel,
  materialNames,
  materialFailedCount,
  readOnly = false,
  onCancel,
}: ConversationStartProps) {
  const [phase, setPhase] = useState<StartPhase>("intro");
  const [failKind, setFailKind] = useState<StartFailKind>("connect");

  async function requestMicAndEnter() {
    try {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) throw new Error("mediaDevices unavailable");
      const stream = await media.getUserMedia({ audio: MIC_CONSTRAINTS });
      for (const track of stream.getTracks()) track.stop();
      setPhase("entering");
    } catch (e) {
      console.error("mic permission request failed", e);
      setFailKind("mic");
      setPhase("failed");
    }
  }

  if (phase === "intro") {
    return (
      <StartIntro
        goal={goal}
        roleLabel={roleLabel}
        materialNames={materialNames}
        materialFailedCount={materialFailedCount}
        onStartVoice={() => setPhase("permission")}
        onBack={onCancel}
      />
    );
  }

  if (phase === "permission") {
    return (
      <MicPermissionModal
        onAllow={requestMicAndEnter}
        onDismiss={() => setPhase("intro")}
      />
    );
  }

  if (phase === "failed") {
    return (
      <StartFailed kind={failKind} onRetry={() => setPhase("entering")} onBack={onCancel} />
    );
  }

  return (
    <LiveKitRoom
      token={conn.token}
      serverUrl={conn.livekit_url}
      connect
      audio
      video={false}
      options={ROOM_OPTIONS}
      style={{ height: "100dvh" }}
      onError={(e) => {
        console.error("livekit start failed", e);
        setFailKind(classifyStartError(e));
        setPhase("failed");
      }}
      onMediaDeviceFailure={() => {
        setFailKind("mic");
        setPhase("failed");
      }}
    >
      <RoomGate conn={conn} readOnly={readOnly} onCancel={onCancel} />
    </LiveKitRoom>
  );
}

function RoomGate({
  conn,
  readOnly,
  onCancel,
}: {
  conn: JoinResponse;
  readOnly: boolean;
  onCancel: () => void;
}) {
  const state = useConnectionState();
  const [hasConnected, setHasConnected] = useState(false);
  useEffect(() => {
    if (state === ConnectionState.Connected) setHasConnected(true);
  }, [state]);

  if (!hasConnected) {
    return <ConnectingOverlay state={state} onCancel={onCancel} />;
  }

  const reconnecting =
    state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting;
  return (
    <Screen className="h-dvh px-4 pt-3">
      <AppHeader brand right={<StartAudio label="音声を有効に" />} />
      <main className="mx-auto flex min-h-0 w-full max-w-[640px] flex-1 flex-col overflow-y-auto lg:max-w-[1160px]">
        <p className="mb-2 text-[12px] text-sanba-muted">
          セッション: <code>{conn.session_id}</code>
        </p>
        <SessionView
          sessionId={conn.session_id}
          sessionToken={conn.session_token}
          readOnly={readOnly}
        />
      </main>
      {reconnecting && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 top-0 z-50 bg-sanba-rec-text/90 py-1 text-center text-[12px] font-bold text-white"
        >
          再接続しています… しばらくお待ちください
        </div>
      )}
    </Screen>
  );
}

export interface StartIntroProps {
  goal: string;
  roleLabel: string;
  materialNames?: string[];
  materialFailedCount?: number;
  onStartVoice: () => void;
  onBack: () => void;
}

function summarizeMaterials(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names[0]} ・ 他${names.length - 1}件`;
}

export function StartIntro({
  goal,
  roleLabel,
  materialNames,
  materialFailedCount,
  onStartVoice,
  onBack,
}: StartIntroProps) {
  const materials = materialNames ?? [];
  const failedCount = materialFailedCount ?? 0;
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="準備ができました" onBack={onBack} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        <div className="flex flex-col items-center gap-2 pt-4">
          <Figure state="walking" className="w-[64px]" />
          <p className="text-[13px] text-sanba-muted">会話を始める準備ができました。</p>
        </div>

        <Card>
          <dl className="flex flex-col gap-[10px] text-[13px]">
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-sanba-muted">ゴール</dt>
              <dd className="text-sanba-cream">{goal.trim() || "（未入力）"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-sanba-muted">役割</dt>
              <dd className="text-sanba-cream">{roleLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[64px] shrink-0 font-bold text-sanba-muted">参考資料</dt>
              <dd className="flex flex-col gap-[2px]">
                {materials.length > 0 ? (
                  <span className="text-sanba-cream">
                    {summarizeMaterials(materials)}
                    <span className="text-sanba-muted">（計{materials.length}件）</span>
                  </span>
                ) : (
                  <span className="text-sanba-muted">会話中に追加できます</span>
                )}
                {failedCount > 0 && (
                  <span role="alert" className="text-[12px] text-sanba-rec-text">
                    {failedCount}件は投入できませんでした。会話中に再度添付できます。
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-sanba-muted">
          <Mic size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>音声で会話するためマイクを使用します。次の画面で許可を求めます。</span>
        </p>

        <div className="mt-1 flex flex-col gap-[8px]">
          <Button variant="gold" size="lg" block onClick={onStartVoice} aria-label="音声で会話を始める">
            <span className="inline-flex items-center justify-center gap-1.5">
              <Mic size={16} aria-hidden /> 会話を始める
            </span>
          </Button>
        </div>
      </main>
    </Screen>
  );
}

export interface MicPermissionModalProps {
  onAllow: () => void | Promise<void>;
  onDismiss: () => void;
}

export function MicPermissionModal({ onAllow, onDismiss }: MicPermissionModalProps) {
  const [requesting, setRequesting] = useState(false);
  async function handleAllow() {
    if (requesting) return;
    setRequesting(true);
    try {
      await onAllow();
    } finally {
      setRequesting(false);
    }
  }
  return (
    <Screen className="relative px-4 py-3">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onDismiss}
        className="fixed inset-0 z-40 cursor-default bg-sanba-frame/60"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="マイクの使用許可"
          className="pointer-events-auto flex w-[316px] flex-col items-center gap-3 rounded-[16px] border-2 border-sanba-frame bg-sanba-surface px-[18px] pb-[18px] pt-5 shadow-[4px_4px_0_var(--sanba-shadow)]"
        >
          <div
            aria-hidden="true"
            className="sanba-gold-gradient flex size-14 items-center justify-center rounded-full border-2 border-sanba-frame text-[24px]"
          >
            <Mic size={26} aria-hidden />
          </div>
          <p className="text-center text-[16px] font-bold text-sanba-gold-text">
            マイクの使用を許可してください
          </p>
          <p className="text-center text-[12px] leading-relaxed text-sanba-muted">
            会話には端末のマイクを使います。使用を許可してください。
          </p>
          <div className="mt-1 flex w-full flex-col gap-[8px]">
            <Button
              variant="gold"
              size="lg"
              block
              onClick={handleAllow}
              disabled={requesting}
              aria-label="マイクの使用を許可する"
            >
              {requesting ? "許可を確認しています…" : "マイクを許可する"}
            </Button>
          </div>
        </div>
      </div>
    </Screen>
  );
}

export interface ConnectingOverlayProps {
  state: ConnectionState;
  onCancel: () => void;
}

export function ConnectingOverlay({ state, onCancel }: ConnectingOverlayProps) {
  const joined = state === ConnectionState.Connected || state === ConnectionState.Reconnecting;
  const reconnecting = state === ConnectionState.Reconnecting;
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="接続しています" />
      <main className="mx-auto flex w-full max-w-[420px] flex-1 flex-col items-center gap-6 pt-12">
        <Figure state="walking" className="w-[64px]" />
        <p className="text-[14px] font-bold text-sanba-gold-text" aria-live="polite">
          {reconnecting ? "再接続しています…" : "接続しています…"}
        </p>
        <ul className="flex w-full flex-col gap-2 text-[13px]">
          <Step done={joined} label="通話に参加" />
          <Step done={false} active label="音声を準備中" />
          <Step done={false} label="SANBA の準備を待っています" />
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
  const Icon = done ? Check : active ? LoaderCircle : Circle;
  const tone = done
    ? "var(--sanba-gold-text)"
    : active
      ? "var(--sanba-cream)"
      : "var(--sanba-muted)";
  return (
    <li className="flex items-center gap-2" style={{ color: tone }}>
      <Icon size={15} aria-hidden className={active ? "animate-spin" : undefined} />
      <span>{label}</span>
    </li>
  );
}

export interface StartFailedProps {
  kind: StartFailKind;
  onRetry: () => void;
  onBack: () => void;
}

export function StartFailed({ kind, onRetry, onBack }: StartFailedProps) {
  const isMic = kind === "mic";
  const [showGuide, setShowGuide] = useState(false);
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="会話を始められませんでした" onBack={onBack} />
      <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col items-center gap-5 pt-12">
        <div
          aria-hidden="true"
          className="flex size-20 items-center justify-center rounded-full text-[32px] font-bold"
          style={{
            backgroundColor: "var(--sanba-rec-pale)",
            border: "2px solid var(--sanba-rec)",
            color: "var(--sanba-rec)",
          }}
        >
          <TriangleAlert size={32} aria-hidden />
        </div>
        <p className="text-[16px] font-bold text-sanba-rec-text">
          {isMic ? "マイクを認識できませんでした" : "接続できませんでした"}
        </p>
        <div className="w-full rounded-[14px] border border-sanba-rec/40 bg-sanba-rec-pale p-[14px] text-[12.5px] leading-relaxed text-sanba-muted">
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
            <>
              <Button
                variant="gold"
                size="lg"
                block
                onClick={() => setShowGuide((v) => !v)}
                aria-expanded={showGuide}
                aria-controls="mic-settings-guide"
                aria-label="ブラウザのマイク設定を開く手順を表示"
              >
                設定を開いて許可する
              </Button>
              {showGuide && (
                <div
                  id="mic-settings-guide"
                  role="region"
                  aria-label="マイク許可の手順"
                  className="rounded-[12px] border border-sanba-border bg-sanba-surface p-[14px] text-left text-[12px] leading-relaxed text-sanba-muted"
                >
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>
                      アドレスバーの錠前（
                      <Lock size={11} aria-hidden className="inline-block align-[-1px]" />
                      ）または情報（
                      <Info size={11} aria-hidden className="inline-block align-[-1px]" />
                      ）をタップ
                    </li>
                    <li>「サイトの設定（権限）」を開く</li>
                    <li>「マイク」を「許可」に変更</li>
                    <li>このページを再読み込みして、もう一度お試しください</li>
                  </ol>
                  <p className="mt-2 text-[11px]">※ お使いのブラウザにより手順が異なる場合があります。</p>
                </div>
              )}
            </>
          )}
          <Button
            variant={isMic ? "ghost" : "gold"}
            size={isMic ? undefined : "lg"}
            block
            onClick={onRetry}
            aria-label="もう一度接続を試す"
          >
            もう一度試す
          </Button>
        </div>
      </main>
    </Screen>
  );
}
