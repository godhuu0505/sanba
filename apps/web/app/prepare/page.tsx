// 02 セッション準備（固有 URL）。入口フローの実体は EntryFlow が持ち、ここは "/prepare"
// ルートの薄い入口。直リンク・共有・リロードで準備画面へ到達できるようにする（ADR-0017 一本道。
// ホーム→準備は EntryFlow が History API でアドレスバーを同期し、直アクセスはこのルートが
// initialStep="prepare" で初期化する）。未ログインは EntryFlow の authGate が /login?next=/prepare へ戻す。
import type { Metadata } from "next";

import EntryFlow from "@/components/EntryFlow";

export const metadata: Metadata = {
  title: "セッション準備 — SANBA",
  description: "役割・ゴール・対象アプリを整えて、要件サンバの壁打ちを始める。",
};

export default function PreparePage() {
  return <EntryFlow initialStep="prepare" />;
}
