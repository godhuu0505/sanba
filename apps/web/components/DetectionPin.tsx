"use client";

// 選択肢なし検知（detection.gap 等）の読み取り専用ピン（#208）。
// 仕様: docs/design/conversation-experience.md §4 / realtime-contract.md §4 detection.gap。
//
// 回答ボタンを持たない未解消検知（抜け＝未定義 等。要約のみ）を、常時ピンの位置に前面表示する。
// 選択肢あり検知（矛盾/抜けで選択肢つき）は回答付きの ChoicePin が担い、本部品は触れない
// （useChoiceDisclosure の 4 モードには関与しない＝Out of Scope の刷新を避ける）。
// 旧 DetectionSheet は復活させず、要約のみの最小ピンに限定する。
//
// a11y: role="status" でスクリーンリーダに未解消の存在を伝える。種別は色のみに依存せず
// バッジ（ラベル＋アイコン）で示す（ADR-0017 / mapping.ts）。

import { detectionPresentation } from "@/lib/realtime/mapping";
import type { DetectionKind } from "@/lib/realtime/types";

export interface DetectionPinProps {
  /** 検知の要約（契約 §4 detection.gap の summary）。 */
  summary: string;
  /** 検知種別（gap/contradiction）。バッジの色・ラベル・アイコンに写像する。 */
  kind: DetectionKind;
}

export function DetectionPin({ summary, kind }: DetectionPinProps) {
  const presentation = detectionPresentation(kind);
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-t-2 bg-[var(--sanba-surface-strong)] px-4 py-[11px]"
      style={{ borderTopColor: presentation.color }}
    >
      <span
        aria-label={presentation.ariaLabel}
        className="shrink-0 rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
        style={{ backgroundColor: presentation.color }}
      >
        {presentation.icon} {presentation.label}
      </span>
      <span className="text-[12px] font-bold text-[var(--sanba-gold-text)]">{summary}</span>
    </div>
  );
}
