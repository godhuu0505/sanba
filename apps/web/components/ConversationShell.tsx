"use client";

// 会話フェーズの共通シェル（04 会話履歴 / 05 参考資料 / 06 要件絵巻 のタブ違い）。
// 仕様: docs/reference/conversation-experience.md §2。
// 固定UI（ヘッダ・ミニ状況・タブ・問いピン・2行ボトムバー）は常時表示し、本文だけタブで切替える。
// 音声会話はタブに依らず継続するため、問いピン/ボトムバーはどのタブでも描画し続ける。
// セッション終了後（08 結果からの閲覧）は review モードで、会話専用 UI（REC・終了・問いピン・
// ボトムバー）を出さない読み取り専用のシェルになる。

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Diamond,
  Paperclip,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Logo, RecPill } from "@/components/sanba";
import type { MiniStatus } from "@/lib/realtime/selectors";

export type ShellTab = "history" | "files" | "scroll";

const TAB_ORDER: ShellTab[] = ["history", "files", "scroll"];
const TAB_LABELS: Record<ShellTab, string> = {
  history: "会話履歴",
  files: "参考資料",
  scroll: "要件絵巻",
};

export interface ConversationShellProps {
  mini: MiniStatus;
  /** 録音中インジケータを出すか。 */
  recording?: boolean;
  /** 経過時間表示（mm:ss）。 */
  elapsed?: string;
  /** 終了（⏹）押下。 */
  onEnd?: () => void;
  /** 初期タブ（非制御時）。 */
  defaultTab?: ShellTab;
  /** 制御タブ。指定すると親が現在タブを所有する（onTabChange で変更通知）。 */
  tab?: ShellTab;
  /** タブ変更通知（ミニ状況/タブ操作・制御/非制御どちらでも発火）。 */
  onTabChange?: (tab: ShellTab) => void;
  /**
   * ミニ状況「未確定」タップ時の追加通知。要件絵巻タブへ移ると同時に、未解消（深掘り）
   * 対象へ視線を誘導するために親が使う。タブ移動自体は onTabChange("scroll") で別途発火する。
   */
  onUnresolvedJump?: () => void;
  /**
   * 参考資料（素材）系 UI を丸ごと出さない（ゲスト読取専用 / ADR-0032 決定4）。
   * タブ「参考資料」とミニ状況の「資料」を隠す。既定 false（従来表示）。
   */
  hideMaterials?: boolean;
  /**
   * セッション終了後の閲覧モード（08 結果 → 「この絵巻を画面で確認する」）。
   * 会話中しか意味を持たない UI（REC・終了⏹・問いピン・ボトムバー）を出さず、
   * 代わりに結果（08）へ戻る導線を出す。既定 false（会話中）。
   */
  review?: boolean;
  /** 閲覧モードで結果（08）へ戻る。 */
  onBackToResult?: () => void;
  /** タブ本文（active のみ描画）。 */
  tabs: Record<ShellTab, ReactNode>;
  /** 常時ピンの「問い＋選択肢」。閲覧モードでは描画しない。 */
  choicePin?: ReactNode;
  /** 常時2行ボトムバー。閲覧モードでは描画しない。 */
  bottomBar?: ReactNode;
  /**
   * 音声状態インジケータ（聞き取り中／発話中／消音中）。可変高の装飾で選択肢フォームを
   * 上下させないよう、ボトムバーではなく上部の固定領域（タブとタブ本文の間）に高さ一定で置く。
   * 閲覧モードでは描画しない。
   */
  voiceStatus?: ReactNode;
}

export function ConversationShell({
  mini,
  recording = true,
  elapsed = "0:00",
  onEnd,
  defaultTab = "history",
  tab: controlledTab,
  onTabChange,
  onUnresolvedJump,
  hideMaterials = false,
  review = false,
  onBackToResult,
  tabs,
  choicePin,
  bottomBar,
  voiceStatus,
}: ConversationShellProps) {
  const [internalTab, setInternalTab] = useState<ShellTab>(defaultTab);
  // ヘッダーナビゲーションの最小化（画面上部の常時 UI を畳んで会話履歴の可視領域を広げる）。
  // 最小化してもタブ・音声状態・ボトムバーは残し、ブランド帯とミニ状況（要件/未確定/資料）を隠す。
  const [minimized, setMinimized] = useState(false);
  const tabOrder = hideMaterials ? TAB_ORDER.filter((t) => t !== "files") : TAB_ORDER;
  // 制御/非制御を明確に二分する。制御時（tab 指定）は内部 state を書かず親を単一の真実とし、
  // defaultTab/internalTab との二重管理を避ける。非制御時のみ内部 state を更新する。
  const isControlled = controlledTab !== undefined;
  const tab = isControlled ? controlledTab : internalTab;
  const setTab = (next: ShellTab) => {
    if (!isControlled) setInternalTab(next);
    onTabChange?.(next);
  };

  return (
    // 親（会話画面の main）が flex 列のときは残り高さいっぱいに伸び（flex-1 min-h-0）、
    // タブ本文だけが内部スクロールする＝ヘッダ/問いピン/ボトムバーは常に画面上下端に固定され、
    // 会話履歴だけがスクロールする。
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* ── 固定ヘッダ（最小化可能）───────────── */}
      {/* ブランドは AppHeader と同じ流儀: 小ロゴ（サンバさんマーク）＋縦罫＋画面タイトル。 */}
      {/* AppHeader と同じく淡い紙面＋藁色の下罫で、紙色の下地との境目を出す。 */}
      {/* 最小化時はブランド帯を細くたたみ、会話履歴の可視領域を広げる（右端の開閉トグルで復帰）。 */}
      <header
        className={`flex items-center gap-2 border-b border-sanba-border-strong bg-sanba-surface-strong px-4 ${
          minimized ? "py-1" : "pb-2 pt-2"
        }`}
      >
        {!minimized && (
          <>
            <Logo size="sm" wordmark={false} className="shrink-0" />
            <span aria-hidden className="h-4 w-px shrink-0 bg-sanba-border-strong" />
          </>
        )}
        <h1
          className={`font-bold text-sanba-cream ${minimized ? "text-[13px]" : "text-[15px]"}`}
        >
          問答
        </h1>
        <span className="flex-1" />
        {review ? (
          // 閲覧モード: 録音・終了は意味を持たないので出さず、結果（08）へ戻る導線に差し替える。
          <button
            type="button"
            aria-label="結果に戻る"
            onClick={onBackToResult}
            className="inline-flex items-center gap-[2px] rounded-full border border-sanba-border bg-sanba-surface px-3 py-[5px] text-[12px] font-bold text-sanba-gold-text"
          >
            <ChevronLeft size={13} aria-hidden /> 結果へ戻る
          </button>
        ) : (
          <>
            {recording && <RecPill>{elapsed}</RecPill>}
            <button
              type="button"
              aria-label="会話を終了"
              onClick={onEnd}
              disabled={!onEnd}
              className="flex size-7 items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-[13px] text-sanba-muted disabled:opacity-40"
            >
              <Square size={13} aria-hidden />
            </button>
          </>
        )}
        {/* ヘッダーナビの最小化/復帰トグル（会話履歴の可視領域を稼ぐ）。 */}
        <button
          type="button"
          aria-label={minimized ? "ヘッダーを開く" : "ヘッダーを最小化"}
          aria-expanded={!minimized}
          onClick={() => setMinimized((m) => !m)}
          className="flex size-7 items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-sanba-muted"
        >
          {minimized ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
        </button>
      </header>

      {/* ── 固定ミニ状況（最小化時は隠す）───────── */}
      {!minimized && (
      <div className="px-4 pb-[6px] pt-2">
        <div
          aria-label="状況"
          className="flex items-center gap-2 rounded-[10px] border border-sanba-border bg-sanba-surface px-3 py-2 text-[11.5px]"
        >
          {/* タップで該当タブへ（要件/未確定→要件絵巻、資料→参考資料）。 */}
          <button
            type="button"
            onClick={() => setTab("scroll")}
            className="inline-flex items-center gap-1 font-bold text-sanba-gold-text"
          >
            <Diamond size={12} aria-hidden /> 要件 {mini.requirements}
          </button>
          <span className="text-sanba-border-strong">・</span>
          <button
            type="button"
            onClick={() => {
              setTab("scroll");
              onUnresolvedJump?.();
            }}
            className="inline-flex items-center gap-1 font-bold text-sanba-caution"
          >
            <TriangleAlert size={12} aria-hidden /> 未確定 {mini.unresolved}
          </button>
          {!hideMaterials && (
            <>
              <span className="text-sanba-border-strong">・</span>
              <button
                type="button"
                onClick={() => setTab("files")}
                className="inline-flex items-center gap-1 text-sanba-muted"
              >
                <Paperclip size={12} aria-hidden /> 資料 {mini.materials}
                {mini.analyzing ? "（解析中）" : ""}
              </button>
            </>
          )}
          <span className="flex-1" />
          <span aria-hidden className="text-sanba-gold-text">
            <ChevronRight size={13} />
          </span>
        </div>
      </div>
      )}

      {/* ── 固定タブ ─────────────────────────── */}
      <div
        role="tablist"
        aria-label="情報タブ"
        className="flex gap-5 border-b border-sanba-border px-4"
      >
        {tabOrder.map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(k)}
              className={`flex flex-col items-center gap-1.5 pt-1.5 text-[13px] ${
                active ? "font-bold text-sanba-gold-text" : "text-sanba-muted"
              }`}
            >
              <span>{TAB_LABELS[k]}</span>
              <span className={`h-[2px] w-full ${active ? "bg-sanba-gold" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      {/* ── 本文（active タブのみ）────────────── */}
      <main role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tabs[tab]}
      </main>

      {/* ── 常時：問いピン＋音声状態インジケータ＋2行ボトムバー（会話中のみ。閲覧モードでは出さない）──── */}
      {/* 問いピン（選択肢フォーム）はテキストフォーム/消音・ミュートボタンの真上に固定する。 */}
      {!review && choicePin}
      {/* 聞き取り中／発話中／消音中の表示。問いピンの下・消音/集音中ボタンの真上に固定する（高さ一定）。 */}
      {!review && voiceStatus && (
        <div className="flex justify-center border-b border-sanba-border bg-sanba-surface-strong px-4 py-1.5">
          {voiceStatus}
        </div>
      )}
      {!review && bottomBar}
    </div>
  );
}
