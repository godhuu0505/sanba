"use client";

// 07 判定（確定ゲート）。終了押下時に未解消が 0 件か検める。
// 仕様: docs/design/conversation-experience.md §7 / screens/07-judgment.md。
// 未解消が 1 件でも残れば確定不可（戻って解く / 未解消のまま終う）。0 件なら確定可。

import { Scale, TriangleAlert } from "lucide-react";

import { useInterviewMode } from "@/lib/interviewMode";
import type { Detection } from "@/lib/realtime/types";

import { Button } from "@/components/sanba";
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
  // end_user モードでは「要件を確定」等の開発語彙を利用者向けに切替える（FR-2.4 / ADR-0032）。
  const endUser = useInterviewMode() === "end_user";

  return (
    <div className="flex h-full flex-col items-center px-4 pb-6 pt-12">
      <div
        className="flex size-20 items-center justify-center rounded-full text-[32px] font-bold"
        style={
          resolved
            ? { background: "var(--sanba-gold)", color: "var(--sanba-ink)" }
            : {
                backgroundColor: "var(--sanba-rec-pale)",
                border: "2px solid var(--sanba-rec)",
                color: "var(--sanba-rec)",
              }
        }
      >
        {resolved ? <Scale size={32} aria-hidden /> : <TriangleAlert size={32} aria-hidden />}
      </div>
      <p className="mt-3 text-[18px] font-bold text-sanba-gold-text">見極めの刻にございます</p>

      {resolved ? (
        <>
          <p className="mt-1 text-center text-[12.5px] text-sanba-muted">
            {endUser
              ? "確認したいことは残っていません。この内容でお伝えできます。"
              : "すべて解けました。要件を確定できます。"}
          </p>
          <div className="flex-1" />
          {error && (
            <p role="alert" className="mb-2 w-full text-center text-[12px] text-sanba-rec-text">
              {error}
            </p>
          )}
          <Button variant="gold" size="lg" block onClick={onConfirm}>
            {endUser ? "この内容で伝える" : "要件を確定する"}
          </Button>
        </>
      ) : (
        <>
          <div className="mt-4 w-full rounded-[14px] border-[1.5px] border-sanba-rec bg-sanba-rec-pale p-[14px]">
            <p className="text-[16px] font-bold text-sanba-rec-text">
              {endUser ? `確認したいことが ${unresolved} 件残っています` : `未解消 ${unresolved} 件 ・ 確定不可`}
            </p>
            <p className="mt-1 text-[11.5px] text-sanba-muted">
              {endUser
                ? "会話に戻ってお答えいただくと、より正確に伝わります。"
                : "ひとつでも残れば、要件は確定できませぬ。"}
            </p>
          </div>
          {detections && detections.length > 0 && onJump && (
            <div className="mt-3 w-full">
              <DeepDiveList detections={detections} onJump={onJump} />
            </div>
          )}
          <div className="flex-1" />
          <Button variant="gold" size="lg" block onClick={onBack}>
            {endUser ? "会話に戻って答える" : "問答に戻って解く"}
          </Button>
          <button
            type="button"
            onClick={onForceEnd}
            className="mt-2 w-full rounded-[12px] border border-sanba-rec/40 py-3 text-[12.5px] font-bold text-sanba-rec-text"
          >
            {endUser ? "このまま終える" : "未解消のまま終う"}
          </button>
        </>
      )}
    </div>
  );
}
