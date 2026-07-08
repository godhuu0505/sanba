export function issueExportReasonText(reason?: string): string {
  switch (reason) {
    case "github not linked":
      return "GitHub と連携すると起票できます（アカウント設定から連携してください）。";
    case "no repo access":
      return "対象リポジトリへの権限がありません（アプリ管理者に確認してください）。";
    case "no repo":
      return "対象アプリにリポジトリが紐づいていないため起票できません。";
    case "not finalized":
      return "会話が未確定のため起票できません（確定した会話だけ起票できます）。";
    case "github app not configured":
      return "GitHub App が未設定のため起票できません。";
    case "guest":
      return "この画面からは起票できません。";
    case "github connector disabled":
      return "GitHub 連携が無効のため起票できませんでした。";
    case "github repo not allowed":
      return "許可されていないリポジトリのため起票できませんでした。";
    default:
      return "起票に失敗しました。時間をおいて再度お試しください。";
  }
}
