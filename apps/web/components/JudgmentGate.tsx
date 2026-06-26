"use client";

// 07 判定（確定ゲート）。終了押下時に未解消が 0 件か検める。
// 仕様: docs/design/conversation-experience.md §7 / screens/07-judgment.md。
// 未解消が 1 件でも残れば確定不可（戻って解く / 未解消のまま終う）。0 件なら確定可。

import type { Detection } from "@/lib/realtime/types";

import { DeepDiveList } from "./DeepDiveList";

export interface JudgmentGateProps {
  unresolved: number;
  /** 未解消の内訳（矛盾/抜け）。渡すと件数だけでなく項目＋戻り先を表示する。 */
  detections?: Detection[];
  /** 問答に戻って解く。 */
  onBack: () => void;
  /** 未解消のまま終う（不可逆・確定されない）。 */
  onForceEnd: () => void;
  /** 要件を確定する（全解消時のみ）。 */
  onConfirm: () => void;
  /** 確定に失敗したときの理由（サーバ 409 等）。表示して結果へ進ませない。 */
  error?: string;
  /** 内訳項目の「会話で確認」押下（該当検知へ）。 */
  onJump?: (detectionId: string) => void;
}

export function JudgmentGate({
  unresolved,
  detections,
  onBack,
  onForceEnd,
  onConfirm,
  error,
  onJump,
}: JudgmentGateProps) {
  const resolved = unresolved === 0;

  return (
    <div className="flex h-full flex-col items-center px-4 pb-6 pt-12">
      <div
        className="flex size-20 items-center justify-center rounded-full text-[32px] font-bold"
        style={
          resolved
            ? { background: "var(--sanba-gold)", color: "var(--sanba-ink)" }
            : { backgroundColor: "#241216", border: "2px solid #d2564b", color: "#d2564b" }
        }
      >
        {resolved ? "⚖" : "⚠"}
      </div>
      <p className="mt-3 text-[18px] font-bold text-[var(--sanba-gold-text)]">見極めの刻にございます</p>

      {resolved ? (
        <>
          <p className="mt-1 text-center text-[12.5px] text-[var(--sanba-muted)]">
            すべて解けました。要件を確定できます。
          </p>
          <div className="flex-1" />
          {error && (
            <p role="alert" className="mb-2 w-full text-center text-[12px] text-[var(--sanba-rec)]">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className="sanba-gold-gradient w-full rounded-[13px] py-[15px] text-[14px] font-bold text-[var(--sanba-ink)]"
          >
            要件を確定する
          </button>
        </>
      ) : (
        <>
          <div className="mt-4 w-full rounded-[14px] border-[1.5px] border-[#d2564b] bg-[#241216] p-[14px]">
            <p className="text-[16px] font-bold text-[#e0857c]">未解消 {unresolved} 件 ・ 確定不可</p>
            <p className="mt-1 text-[11.5px] text-[var(--sanba-muted)]">
              ひとつでも残れば、要件は確定できませぬ。
            </p>
          </div>
          {detections && detections.length > 0 && onJump && (
            <div className="mt-3 w-full">
              <DeepDiveList detections={detections} onJump={onJump} />
            </div>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onBack}
            className="sanba-gold-gradient w-full rounded-[13px] py-[15px] text-[14px] font-bold text-[var(--sanba-ink)]"
          >
            問答に戻って解く
          </button>
          <button
            type="button"
            onClick={onForceEnd}
            className="mt-2 w-full rounded-[12px] border border-[#7a3a36] py-3 text-[12.5px] font-bold text-[var(--sanba-rec)]"
          >
            未解消のまま終う
          </button>
        </>
      )}
    </div>
  );
}
