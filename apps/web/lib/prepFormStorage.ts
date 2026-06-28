// 02 準備フォーム（ゴール / 役割 / 同意）を /login 往復で失わないための一時保存（#179）。
// sessionStorage（タブ内のみ・閉じると消える）に置く。機微情報ではない（goal は要件メモ、
// role/consent は選択値）。認証情報は対象外（auth.tsx の「credential を永続化しない」方針は不変）。

const KEY = "sanba.prep.v1";

export interface PrepForm {
  role?: string;
  goal?: string;
  consent?: boolean;
}

/** 保存済みの準備フォームを読み出す。未保存/壊れた値/利用不可なら空を返す（本流を止めない）。 */
export function readPrep(): PrepForm {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    const out: PrepForm = {};
    // 型が一致するフィールドのみ復元する（壊れた値で UI を壊さない）。
    if (typeof o.role === "string") out.role = o.role;
    if (typeof o.goal === "string") out.goal = o.goal;
    if (typeof o.consent === "boolean") out.consent = o.consent;
    return out;
  } catch {
    return {};
  }
}

/** 準備フォームを保存する。sessionStorage 不可（プライベートブラウズ等）でも黙って no-op。 */
export function writePrep(form: PrepForm): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(form));
  } catch {
    // 保存できなくても本流（壁打ち開始）は止めない。
  }
}

/** 保存をクリアする（壁打ち開始の成功後など、入力を再利用したくないとき）。 */
export function clearPrep(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
