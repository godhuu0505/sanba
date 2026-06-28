"use client";

// 会話フェーズの共通シェル（04 会話履歴 / 05 参考資料 / 06 要件絵巻 のタブ違い）。
// 仕様: docs/design/conversation-experience.md §2。
// 固定UI（ヘッダ・ミニ状況・タブ・問いピン・2行ボトムバー）は常時表示し、本文だけタブで切替える。
// 音声会話はタブに依らず継続するため、問いピン/ボトムバーはどのタブでも描画し続ける。

import { useState, type ReactNode } from "react";

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
   * ミニ状況「未確定」タップ時の追加通知（#195）。要件絵巻タブへ移ると同時に、未解消（深掘り）
   * 対象へ視線を誘導するために親が使う。タブ移動自体は onTabChange("scroll") で別途発火する。
   */
  onUnresolvedJump?: () => void;
  /** タブ本文（active のみ描画）。 */
  tabs: Record<ShellTab, ReactNode>;
  /** 常時ピンの「問い＋選択肢」。 */
  choicePin?: ReactNode;
  /** 常時2行ボトムバー。 */
  bottomBar: ReactNode;
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
  tabs,
  choicePin,
  bottomBar,
}: ConversationShellProps) {
  const [internalTab, setInternalTab] = useState<ShellTab>(defaultTab);
  // 制御/非制御を明確に二分する。制御時（tab 指定）は内部 state を書かず親を単一の真実とし、
  // defaultTab/internalTab との二重管理を避ける。非制御時のみ内部 state を更新する。
  const isControlled = controlledTab !== undefined;
  const tab = isControlled ? controlledTab : internalTab;
  const setTab = (next: ShellTab) => {
    if (!isControlled) setInternalTab(next);
    onTabChange?.(next);
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── 固定ヘッダ ───────────────────────── */}
      <header className="flex items-center gap-2 px-4 pb-2 pt-2">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-full bg-[var(--sanba-frame)] text-[13px] font-bold text-[var(--sanba-ink)]"
        >
          産
        </span>
        <h1 className="text-[15px] font-bold text-[var(--sanba-cream)]">問答</h1>
        <span className="flex-1" />
        {recording && (
          <span className="rounded-full bg-[#2a1416] px-[9px] py-1 text-[11px] font-bold text-[var(--sanba-rec)]">
            ● REC {elapsed}
          </span>
        )}
        <button
          type="button"
          aria-label="会話を終了"
          onClick={onEnd}
          disabled={!onEnd}
          className="flex size-7 items-center justify-center rounded-full border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[13px] text-[var(--sanba-muted)] disabled:opacity-40"
        >
          ⏹
        </button>
      </header>

      {/* ── 固定ミニ状況 ─────────────────────── */}
      <div className="px-4 pb-[6px]">
        <div
          aria-label="状況"
          className="flex items-center gap-2 rounded-[10px] border border-[var(--sanba-border)] bg-[#1b140b] px-3 py-2 text-[11.5px]"
        >
          {/* タップで該当タブへ（要件/未確定→要件絵巻、資料→参考資料）。 */}
          <button type="button" onClick={() => setTab("scroll")} className="font-bold text-[var(--sanba-gold-text)]">
            ◆ 要件 {mini.requirements}
          </button>
          <span className="text-[#6b5836]">・</span>
          <button
            type="button"
            onClick={() => {
              setTab("scroll");
              onUnresolvedJump?.();
            }}
            className="font-bold text-[#e0a93b]"
          >
            ⚠ 未確定 {mini.unresolved}
          </button>
          <span className="text-[#6b5836]">・</span>
          <button type="button" onClick={() => setTab("files")} className="text-[var(--sanba-muted)]">
            📎 資料 {mini.materials}
            {mini.analyzing ? "（解析中）" : ""}
          </button>
          <span className="flex-1" />
          <span aria-hidden className="text-[var(--sanba-gold-text)]">›</span>
        </div>
      </div>

      {/* ── 固定タブ ─────────────────────────── */}
      <div
        role="tablist"
        aria-label="情報タブ"
        className="flex gap-5 border-b border-[#3a2e1a] px-4"
      >
        {TAB_ORDER.map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(k)}
              className={`flex flex-col items-center gap-1.5 pt-1.5 text-[13px] ${
                active ? "font-bold text-[var(--sanba-gold-text)]" : "text-[var(--sanba-muted)]"
              }`}
            >
              <span>{TAB_LABELS[k]}</span>
              <span className={`h-[2px] w-full ${active ? "bg-[var(--sanba-gold)]" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      {/* ── 本文（active タブのみ）────────────── */}
      <main role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tabs[tab]}
      </main>

      {/* ── 常時：問いピン＋2行ボトムバー ──────── */}
      {choicePin}
      {bottomBar}
    </div>
  );
}
