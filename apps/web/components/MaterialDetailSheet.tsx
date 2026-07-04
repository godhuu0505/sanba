"use client";

// 05-1 資料詳細（ボトムシート）。1素材の抽出要件チップと「言葉×画の矛盾」を種別別に確認する。
// 仕様: docs/design/conversation-experience.md §6 / docs/design/screens/05-materials.md / Figma 148:2。
//
// 設計ポイント:
// - PR #200 で AnalysisView をマウントから外した結果、analysis.visual の conflicts（言葉×画の矛盾）の
//   表示先が消えた（#202）。一覧（MaterialsList）の素材行 → 本シートで再び surface する。
// - conflicts は store 既存形（AnalysisVisualConflict）をそのまま受ける。detection.* の有無に依らず
//   analysis.visual に保持された矛盾を出すため、「視覚解析のみの矛盾（detection 無し）」も確認できる。
// - 色/バッジは mapping.ts に倣う（緋=矛盾）。色のみに依存せず必ずラベル＋アイコンを伴う（ADR-0017）。
// - a11y: 暗幕＋ボトムシート（role=dialog/aria-modal）、ESC で閉じる、フォーカストラップ、
//   見た目（古語）に依らない現代語ラベル（MaterialSourceSheet を踏襲）。

import { useEffect, useRef } from "react";
import { Check, Image as ImageIcon, X } from "lucide-react";

import { detectionPresentation } from "../lib/realtime/mapping";
import type { MaterialDetail } from "../lib/realtime/selectors";

export interface MaterialDetailSheetProps {
  detail: MaterialDetail;
  /** 閉じる（✕ / 暗幕 / ESC）。 */
  onClose: () => void;
  /**
   * 矛盾を「会話で確認」する導線（会話履歴タブへ戻す・任意）。
   * 起票（要件化）はバックエンド未接続のため出さない（偽ボタンを作らない・CLAUDE.md）。
   */
  onConfirmInConversation?: () => void;
}

// 緋＝言葉×画の矛盾。色トークン/アイコン/ariaLabel は mapping.ts（矛盾）に倣う。
const CONFLICT = detectionPresentation("contradiction");

export function MaterialDetailSheet({
  detail,
  onClose,
  onConfirmInConversation,
}: MaterialDetailSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = "material-detail-title";

  // 開いたらシート内へフォーカスを移す（a11y）。
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // ESC で閉じる＋Tab をシート内に閉じ込める（フォーカストラップ・a11y / MaterialSourceSheet 踏襲）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = sheetRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const done = detail.status === "done";
  // 解析結果（analysis.visual）を保持しているときだけ、空を「無し」と断定してよい。
  // 未取得（再接続後の done 行・#184 未対応）/解析途中は断定せず「未取得/解析中」を出す。
  const ready = detail.analysisReady;
  const waiting = done
    ? "解析結果はこの場では取得できていません。"
    : "解析が終わると、ここに表示されます。";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* 暗幕（MaterialSourceSheet 踏襲）。クリックで閉じる。 */}
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[85vh] w-full max-w-[420px] flex-col gap-3 overflow-y-auto rounded-t-[18px] border-t-2 border-[var(--sanba-frame)] bg-[var(--sanba-surface)] px-4 pb-[18px] pt-[12px]"
      >
        <div className="flex items-center gap-2">
          <span id={titleId} className="text-[15px] font-bold text-[var(--sanba-gold-text)]">
            資料の詳細
          </span>
          <span className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex size-[26px] items-center justify-center rounded-full border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[12px] text-[var(--sanba-muted)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        {/* プレビュー枠（画像 URL は store に無いためプレースホルダ・Figma 150:2 踏襲）。 */}
        <div
          aria-hidden="true"
          className="flex h-[140px] items-center justify-center gap-1.5 rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface-strong)] text-[13px] text-[var(--sanba-muted)]"
        >
          <ImageIcon size={16} aria-hidden /> {detail.name}
        </div>

        {/* メタ（名前・解析状態）。解析中は進捗バーで状態を可視化（色のみに依存しない）。 */}
        <div className="flex flex-col gap-[6px]">
          <span className="text-[11.5px] font-bold text-[var(--sanba-cream)]">{detail.name}</span>
          {done ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--sanba-speak-text)]">
              <Check size={13} aria-hidden /> 解析済
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[var(--sanba-muted)]">解析中</span>
              <div
                role="progressbar"
                aria-valuenow={detail.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="解析の進捗"
                className="h-[5px] flex-1 overflow-hidden rounded-full bg-[var(--sanba-border)]"
              >
                <div className="sanba-gold-gradient h-full" style={{ width: `${detail.pct}%` }} />
              </div>
              <span className="text-[11px] font-bold text-[var(--sanba-gold-text)]">{detail.pct}%</span>
            </div>
          )}
        </div>

        {/* 種別①: 抽出した要件（チップ）。 */}
        <section aria-label="抽出した要件" className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-[var(--sanba-gold-text)]">抽出した要件</span>
          {detail.extracted.length > 0 ? (
            <ul className="flex list-none flex-wrap gap-[6px] p-0">
              {detail.extracted.map((e, i) => (
                <li
                  key={`${e}-${i}`}
                  className="rounded-[999px] border border-[var(--sanba-gold-deep)] bg-[var(--sanba-surface-strong)] px-[11px] py-[6px] text-[12px] font-bold text-[var(--sanba-gold-text)]"
                >
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-[var(--sanba-muted)]">
              {ready ? "抽出された要件はありません。" : waiting}
            </p>
          )}
        </section>

        {/* 種別②: 言葉×画の矛盾（緋）。detection.* に依らず analysis.visual の矛盾を surface する。 */}
        <section aria-label="言葉×画の矛盾" className="flex flex-col gap-2">
          <span className="text-[12px] font-bold" style={{ color: CONFLICT.color }}>
            言葉×画の矛盾
          </span>
          {detail.conflicts.length > 0 ? (
            detail.conflicts.map((c, i) => (
              <div
                key={`${c.summary}-${i}`}
                className="flex flex-col gap-[6px] rounded-[12px] border-[1.5px] px-[12px] py-[11px]"
                style={{ borderColor: CONFLICT.color, background: "var(--sanba-rec-pale)" }}
              >
                <span
                  role="status"
                  aria-label={CONFLICT.ariaLabel}
                  className="inline-flex w-fit items-center gap-1 rounded-[999px] px-[7px] py-[2px] text-[10px] font-bold text-white"
                  style={{ background: CONFLICT.color }}
                >
                  <span aria-hidden="true">{CONFLICT.icon}</span>
                  <span>言葉×画の矛盾</span>
                </span>
                <span className="text-[12.5px] text-[var(--sanba-cream)]">{c.summary}</span>
                {onConfirmInConversation && (
                  <button
                    type="button"
                    onClick={onConfirmInConversation}
                    className="w-fit text-[11px] font-bold text-[var(--sanba-gold-text)]"
                  >
                    会話で確認 ›
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="text-[11.5px] text-[var(--sanba-muted)]">
              {ready ? "言葉×画の矛盾は見つかっていません。" : waiting}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
