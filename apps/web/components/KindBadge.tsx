// 色のみに依存しない種別バッジ（Issue #101 DoD / 05・08 の AC）。
//
// 色覚特性に関わらず判別できるよう、必ず **アイコン + ラベル** を伴わせる。色は補助。
// 検知（矛盾/抜け）・要件カテゴリのどちらにも使える汎用表示。

import type { KindPresentation } from "../lib/realtime/mapping";

export function KindBadge({ p }: { p: KindPresentation }) {
  return (
    <span
      role="status"
      aria-label={p.ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        // 色は補助。背景は淡く、文字色＝トークン色。境界線でも区別できるようにする。
        color: p.color,
        background: `${p.color}1A`,
        border: `1px solid ${p.color}`,
        lineHeight: 1.6,
      }}
    >
      <span aria-hidden="true">{p.icon}</span>
      <span>{p.label}</span>
    </span>
  );
}
