// 要件結果ドキュメントの読み手（audience）の表示ラベル。
// 値は API の Audience（end_user/planner/developer）で、表示のみ日本語にする。

import type { Audience } from "./api";

export const AUDIENCE_LABELS: Record<Audience, string> = {
  end_user: "利用者",
  planner: "企画者",
  developer: "開発者",
};

/** 表示順（準備画面の役割チップと同じ 利用者 → 企画者 → 開発者）。 */
export const AUDIENCES: Audience[] = ["end_user", "planner", "developer"];
