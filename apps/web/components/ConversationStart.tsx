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
import { Check, Circle, LoaderCircle, Mic, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { AppHeader, Button, Card, Screen } from "@/components/sanba";

import type { JoinResponse } from "../lib/api";
import { SessionView } from "./SessionView";

type StartPhase = "intro" | "permission" | "entering" | "failed";

/** 失敗の種別（理由提示の出し分け）。mic=許可拒否 / connect=接続失敗。 */
export type StartFailKind = "mic" | "connect";

export interface ConversationStartProps {
  conn: JoinResponse;
  /** 02 で入力したゴール（開始前サマリに引き継ぐ）。 */
  goal: string;
  /** 02 で選んだ役割の表示名。 */
  roleLabel: string;
  /** 02 で添付し「実際に投入できた」参考資料のファイル名（開始前サマリに引き継ぐ / 監査 B-2 #11）。 */
  materialNames?: string[];
  /** 投入に失敗した参考資料の件数（>0 なら注意書きを出す / Codex P2）。 */
  materialFailedCount?: number;
  /** 中断して準備（02）へ戻す。 */
  onCancel: () => void;
}

export function ConversationStart({
  conn,
  goal,
  roleLabel,
  materialNames,
  materialFailedCount,
  onCancel,
}: ConversationStartProps) {
  const [phase, setPhase] = useState<StartPhase>("intro");
  // 音声で始めるか（テキストで進める場合はマイク publish せず接続する）。
  const [withMic, setWithMic] = useState(true);
  const [failKind, setFailKind] = useState<StartFailKind>("connect");

  if (phase === "intro") {
    return (
      <StartIntro
        goal={goal}
        roleLabel={roleLabel}
        materialNames={materialNames}
        materialFailedCount={materialFailedCount}
        // OS プロンプト前に 03-2 アプリ内モーダルで理由提示してから許可を求める（03 AC）。
        onStartVoice={() => setPhase("permission")}
        onStartText={() => {
          setWithMic(false);
          setPhase("entering");
        }}
        onBack={onCancel}
      />
    );
  }

  if (phase === "permission") {
    return (
      <MicPermissionModal
        onAllow={() => {
          setWithMic(true);
          setPhase("entering");
        }}
        onText={() => {
          setWithMic(false);
          setPhase("entering");
        }}
        onDismiss={() => setPhase("intro")}
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
  // 一度でも接続が成立したか。初回接続前のみ全面ローディングを出し、以後の一時的な再接続では
  // SessionView をアンマウントしない（store・回答済み質問・投入素材・判定/結果フェーズなどの
  // ローカル状態を失わないため / Codex P2）。
  const [hasConnected, setHasConnected] = useState(false);
  useEffect(() => {
    if (state === ConnectionState.Connected) setHasConnected(true);
  }, [state]);

  // 初回接続が成立するまでは接続中表示（03-1）。SessionView はまだ載せない。
  if (!hasConnected) {
    return <ConnectingOverlay state={state} onCancel={onCancel} />;
  }

  // 接続後は SessionView を載せたまま保持する。一時的な再接続中は状態を壊さないよう
  // アンマウントせず、上から非破壊のオーバーレイ帯で知らせるだけにする。
  const reconnecting = state !== ConnectionState.Connected;
  return (
    <Screen className="px-4 py-3">
      <AppHeader brand right={<StartAudio label="音声を有効に" />} />
      <main className="mx-auto w-full max-w-[640px] flex-1">
        <p className="mb-2 text-[12px] text-sanba-muted">
          セッション: <code>{conn.session_id}</code>
        </p>
        <SessionView sessionId={conn.session_id} sessionToken={conn.session_token} />
      </main>
      {reconnecting && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 top-0 z-50 bg-sanba-rec-text/90 py-1 text-center text-[12px] font-bold text-white"
        >
          繋ぎ直しております… しばらくお待ちください
        </div>
      )}
    </Screen>
  );
}

// ── 純プレゼン（テスト可能・LiveKit 非依存）─────────────────────────────────

export interface StartIntroProps {
  goal: string;
  roleLabel: string;
  /** 02 で添付し投入できた参考資料のファイル名（無ければ「会話中に追加できます」を出す）。 */
  materialNames?: string[];
  /** 投入に失敗した件数（>0 なら注意書きを出す）。 */
  materialFailedCount?: number;
  onStartVoice: () => void;
  onStartText: () => void;
  onBack: () => void;
}

/** 添付名のサマリ表示。Figma 89:132 の `PRD_検索改善.pdf ・ 他1件` に倣う（監査 B-2 #11）。 */
function summarizeMaterials(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names[0]} ・ 他${names.length - 1}件`;
}

/** 03-0 開始前。準備サマリ＋マイク注記（OS プロンプト前の理由提示）＋開始導線。 */
export function StartIntro({
  goal,
  roleLabel,
  materialNames,
  materialFailedCount,
  onStartVoice,
  onStartText,
  onBack,
}: StartIntroProps) {
  const materials = materialNames ?? [];
  const failedCount = materialFailedCount ?? 0;
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
          <p className="text-[13px] text-sanba-muted">問答を始める支度が整いました。</p>
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

        {/* OS プロンプトの前にマイク使用の理由を提示する（03 AC）。 */}
        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-sanba-muted">
          <Mic size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>音声で問答するためマイクを使用します。次の画面で許可を求めます。</span>
        </p>

        <div className="mt-1 flex flex-col gap-[8px]">
          <Button variant="gold" size="lg" block onClick={onStartVoice} aria-label="音声で会話を始める">
            <span className="inline-flex items-center justify-center gap-1.5">
              <Mic size={16} aria-hidden /> 問答を始める
            </span>
          </Button>
          <Button variant="ghost" block onClick={onStartText} aria-label="音声を使わずテキストで進める">
            テキストで進める
          </Button>
        </div>
      </main>
    </Screen>
  );
}

export interface MicPermissionModalProps {
  /** マイク許可へ（OS プロンプトを呼ぶ＝音声で接続）。 */
  onAllow: () => void;
  /** 音声を使わずテキストで進める。 */
  onText: () => void;
  /** 暗幕タップ等で閉じ、03-0 へ戻す。 */
  onDismiss: () => void;
}

/**
 * 03-2 録音許可モーダル。OS のマイク許可プロンプトを呼ぶ前に、アプリ内で理由を提示する
 * （Figma `139:156`）。暗幕＋中央モーダル。表示は古語、操作の aria-label は現代語（ADR-0017）。
 */
export function MicPermissionModal({ onAllow, onText, onDismiss }: MicPermissionModalProps) {
  return (
    <Screen className="relative px-4 py-3">
      {/* 暗幕（scrim）。タップで閉じて 03-0 へ戻る。 */}
      <button
        type="button"
        aria-label="閉じる"
        onClick={onDismiss}
        className="fixed inset-0 z-40 cursor-default bg-sanba-frame/60"
      />
      {/* ラッパーは全画面だが pointer-events-none で、空き領域のクリックは下の暗幕ボタンへ通す。
          ダイアログ本体だけ pointer-events-auto で操作可能にする（暗幕タップ→onDismiss を阻害しない）。 */}
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
            声を聞かせてくださいませ
          </p>
          <p className="text-center text-[12px] leading-relaxed text-sanba-muted">
            問答には端末のマイクを用います。使用を許可してください。
          </p>
          <div className="mt-1 flex w-full flex-col gap-[8px]">
            <Button variant="gold" size="lg" block onClick={onAllow} aria-label="マイクの使用を許可する">
              マイクを許可する
            </Button>
            <Button variant="ghost" block onClick={onText} aria-label="音声を使わずテキストで進める">
              テキストで進める
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
          className="sanba-gold-gradient sanba-serif flex size-20 animate-pulse items-center justify-center rounded-full border-2 border-sanba-frame text-[30px] font-bold text-sanba-ink"
        >
          産
        </div>
        <p className="text-[14px] font-bold text-sanba-gold-text" aria-live="polite">
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
  onText: () => void;
  onBack: () => void;
}

/** 03-3 失敗系。原因提示＋3導線（設定で許可・再試行・テキストで続ける）。 */
export function StartFailed({ kind, onRetry, onText, onBack }: StartFailedProps) {
  const isMic = kind === "mic";
  // 「設定を開いて許可する」押下で手順ガイドを同画面に展開する。Web からブラウザ/OS 設定は
  // API で直接開けないため、文言フォールバックで誘導する（03 AC「不可環境では文言フォールバック」）。
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
          {isMic ? "声を捉えられませなんだ" : "繋ぐことが叶いませなんだ"}
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
          {/* マイク失敗の主操作（Figma 139:233 第一 CTA）。設定を直接は開けないため手順を展開する。 */}
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
                    <li>アドレスバーの 🔒 / ⓘ をタップ</li>
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
          <Button variant="ghost" block onClick={onText} aria-label="音声を使わずテキストで続ける">
            テキストで続ける
          </Button>
        </div>
      </main>
    </Screen>
  );
}
