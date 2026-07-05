// 01 ホーム（入口フロー）。実体は EntryFlow が持ち、ここは "/" ルートの薄い入口
// （ADR-0017 一本道）。準備画面は固有 URL "/prepare"（app/prepare/page.tsx）へ分離した。
import EntryFlow from "@/components/EntryFlow";

export default function Home() {
  return <EntryFlow initialStep="home" />;
}
