"use client";

// 08 結果（要件産婆結果）。確定要件の受け渡し。
// 仕様: docs/design/conversation-experience.md §7 / screens/08-result.md / Figma 144:86。
// 画面で確認＝必須。PDF/Drive/Issue 出力＝任意（ハンドラがあるものだけ出す）。

import { categoryPresentation, priorityLabel } from "../lib/realtime/mapping";
import type { Priority, Requirement } from "../lib/realtime/types";

/** プレビューで先に出す優先度（Figma 08：Must/Should を優先表示）。 */
const PREVIEW_PRIORITIES: readonly Priority[] = ["must", "should"];
/** 各優先度セクションでプレビューに出す最大件数。超過は「ほか N 件 ›」へ畳む。 */
const SECTION_LIMIT = 3;

export interface ResultViewProps {
  confirmedCount: number;
  /** Must/Should/Could の内訳（任意）。 */
  breakdown?: { must: number; should: number; could: number };
  /**
   * プレビューに出す確定要件（status==="confirmed" のもの／selectConfirmedRequirements 由来）。
   * 確定判定は呼び出し側のセレクタに一元化し、本コンポーネントは表示のみを担う。
   * 未指定（テスト等）ならプレビューは出さず件数サマリのみ。
   */
  requirements?: Requirement[];
  /** 未解消を残したまま終了した暫定結果か（07 の onForceEnd 経路）。確定済みと区別する。 */
  provisional?: boolean;
  /** この絵巻を画面で確認する（既定動線・必須）。 */
  onView: () => void;
  /** 新しい問答を始める。 */
  onRestart: () => void;
  /** 任意出力。未指定のものはボタンを出さない。 */
  onExportPdf?: () => void;
  onExportDrive?: () => void;
  onExportIssue?: () => void;
}

export function ResultView({
  confirmedCount,
  breakdown,
  requirements,
  provisional = false,
  onView,
  onRestart,
  onExportPdf,
  onExportDrive,
  onExportIssue,
}: ResultViewProps) {
  const outputs: { label: string; handler?: () => void }[] = [
    { label: "📄 PDF", handler: onExportPdf },
    { label: "☁ Drive", handler: onExportDrive },
    { label: "🐙 Issue", handler: onExportIssue },
  ];
  const available = outputs.filter((o) => o.handler);

  // 確定要件のプレビュー（Figma 144:86）。Must/Should を優先表示し、各セクション SECTION_LIMIT 件まで。
  // それ以外（Could/Won't や上限超過分）は「ほか N 件 ›」に畳んで全文（onView）へ誘導する。
  // 空の優先度セクションは描画しない。
  const confirmedReqs = requirements ?? [];
  const previewGroups = PREVIEW_PRIORITIES.map((priority) => ({
    priority,
    items: confirmedReqs.filter((r) => r.priority === priority).slice(0, SECTION_LIMIT),
  })).filter((g) => g.items.length > 0);
  const previewedCount = previewGroups.reduce((n, g) => n + g.items.length, 0);
  const overflowCount = confirmedReqs.length - previewedCount;

  return (
    <div className="flex h-full flex-col items-center px-4 pb-4 pt-5">
      <div className="sanba-gold-gradient flex size-[78px] items-center justify-center rounded-full text-[28px] font-bold text-[var(--sanba-ink)]">
        産
      </div>
      <p className="mt-[10px] text-center text-[18px] font-bold text-[var(--sanba-gold-text)]">
        {provisional ? "暫定で書き留めました" : "オーレ！ 要件、産まれました"}
      </p>
      <p className="mt-1 text-center text-[12px] text-[var(--sanba-muted)]">
        {provisional ? "暫定要件 " : "確定要件 "}
        {confirmedCount} 件
        {breakdown ? `（Must ${breakdown.must} ・ Should ${breakdown.should} ・ Could ${breakdown.could}）` : ""}
        {provisional ? " ・ 未確定を残したまま終了" : ""}
      </p>

      {(previewGroups.length > 0 || overflowCount > 0) && (
        <div
          aria-label="確定要件のプレビュー"
          className="mt-3 w-full space-y-3 overflow-y-auto"
        >
          {previewGroups.map((g) => (
            <section key={g.priority} aria-label={priorityLabel(g.priority)}>
              <h3 className="text-[10.5px] font-bold text-[var(--sanba-muted)]">
                {priorityLabel(g.priority)}
              </h3>
              <ul className="mt-[6px] space-y-[6px]">
                {g.items.map((r) => {
                  const cat = categoryPresentation(r.category);
                  return (
                    <li
                      key={r.id}
                      className="flex items-start gap-2 rounded-[11px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-3 py-[9px]"
                    >
                      <span
                        aria-hidden
                        className="mt-[1px] text-[11px] font-bold"
                        style={{ color: cat.color }}
                      >
                        {cat.icon}
                      </span>
                      <span className="sr-only">{cat.ariaLabel}</span>
                      <span className="flex-1 text-[12.5px] leading-[1.5] text-[var(--sanba-ink)]">
                        {r.statement}
                      </span>
                      <span aria-hidden className="mt-[1px] text-[11px] text-[var(--sanba-gold-text)]">
                        ✓
                      </span>
                      <span className="sr-only">確定済み</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {overflowCount > 0 && (
            <button
              type="button"
              onClick={onView}
              className="text-[11.5px] font-bold text-[var(--sanba-gold-text)]"
            >
              ほか {overflowCount} 件 ・ タップで全文 ›
            </button>
          )}
        </div>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onView}
        aria-label="この絵巻を画面で確認する（確定要件の全文）"
        className="sanba-gold-gradient w-full rounded-[13px] py-[15px] text-[14px] font-bold text-[var(--sanba-ink)]"
      >
        この絵巻を画面で確認する ›
      </button>

      {available.length > 0 && (
        <>
          <p className="mt-2 self-start text-[10.5px] font-bold text-[var(--sanba-muted)]">書き出す（任意）</p>
          <div className="mt-[6px] flex w-full gap-2">
            {available.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={o.handler}
                className="flex-1 rounded-[11px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] py-[11px] text-[11.5px] font-bold text-[var(--sanba-muted)]"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onRestart}
        className="mt-[10px] text-[12px] font-bold text-[var(--sanba-gold-text)]"
      >
        新しい問答を始める
      </button>
    </div>
  );
}
