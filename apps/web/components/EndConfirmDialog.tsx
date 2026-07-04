"use client";

// 終了確認ダイアログ。⏹ 押下時に確定ゲート（未解消件数）を提示する。
// 仕様: docs/design/conversation-experience.md §C(横断)/§7 / screens/07-judgment.md。

export interface EndConfirmDialogProps {
  /** 未解消（矛盾/抜け/不明瞭）の件数。 */
  unresolved: number;
  onContinue: () => void;
  onEnd: () => void;
}

export function EndConfirmDialog({ unresolved, onContinue, onEnd }: EndConfirmDialogProps) {
  const hasUnresolved = unresolved > 0;
  return (
    <div
      role="dialog"
      aria-label="終了確認"
      aria-modal="true"
      className="flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-[var(--sanba-frame)] bg-[var(--sanba-surface)] px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
    >
      <div
        className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
        style={{
          borderColor: hasUnresolved ? "var(--sanba-rec)" : "var(--sanba-gold-deep)",
          color: hasUnresolved ? "var(--sanba-rec)" : "var(--sanba-gold-text)",
        }}
      >
        {hasUnresolved ? "⚠" : "⚖"}
      </div>
      <p className="text-center text-[16px] font-bold text-[var(--sanba-gold-text)]">問答を終えますか？</p>
      <p className="text-center text-[12px] text-[var(--sanba-muted)]">
        {hasUnresolved
          ? `未解消が ${unresolved} 件 残っています。終えると、その分は確定されません。`
          : "未解消はありません。いつでも確定できます。"}
      </p>
      <div className="flex w-full gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 rounded-[12px] border border-[var(--sanba-frame)] py-[13px] text-[13px] font-bold text-[var(--sanba-gold-text)]"
        >
          問答を続ける
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="flex-1 rounded-[12px] bg-[var(--sanba-rec)] py-[13px] text-[13px] font-bold text-white"
        >
          終了する
        </button>
      </div>
    </div>
  );
}
