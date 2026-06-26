"use client";

// 08 結果（要件産婆結果）。確定要件の受け渡し。
// 仕様: docs/design/conversation-experience.md §7 / screens/08-result.md。
// 画面で確認＝必須。PDF/Drive/Issue 出力＝任意（ハンドラがあるものだけ出す）。

export interface ResultViewProps {
  confirmedCount: number;
  /** Must/Should/Could の内訳（任意）。 */
  breakdown?: { must: number; should: number; could: number };
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

      <div className="flex-1" />

      <button
        type="button"
        onClick={onView}
        className="sanba-gold-gradient w-full rounded-[13px] py-[15px] text-[14px] font-bold text-[var(--sanba-ink)]"
      >
        この絵巻を画面で確認する
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
