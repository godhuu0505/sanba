# ADR-0065: セキュリティ監査対応 — 本番環境の fail-closed 設定ガード

- ステータス: Accepted
- 日付: 2026-07-10
- 関連: ADR-0012（Google ログイン・信頼境界）、ADR-0043（プロンプトインジェクション・非信頼データのフェンス化）、
  ADR-0047（ログイン nonce）、ADR-0060（サーバサイドセッション）、`security-audit/`（本対応の一次情報）

## コンテキスト

`origin/main` 全ソースの静的セキュリティ監査（`security-audit/findings.md`、確定 84 件 = P1 16 / P2 68）で、
複数の指摘が同じ根に帰着した: **設定漏れがフェイルオープンになる**。具体的には、

- 公開ソース上の固定シークレット（`livekit_api_key/secret = devkey/secret`、
  `session_signing_secret = dev-only-insecure-secret-change-me`）が環境変数未注入でも起動を通し、
  推測可能な鍵でトークン発行・署名が成立しうる（SEC-005/008/009/013/048）。
- 開発用フラグ（`AUTH_DEV_BYPASS`、`LOCAL_DIRECT_DISPATCH`）が本番で誤って true になると、
  認証・OIDC を全て飛ばす分岐が関数先頭に存在する（SEC-007/012/032/035/041/043）。

いずれも「既定が安全側でなく、誤設定を検知して停止する仕組みが無い」ことが本質だった。
個別分岐を潰すのではなく、**誤設定を起動時に検知して落とす一点の防御**を置くのが妥当と判断した。

## 決定

デプロイ環境を表す明示フィールド `environment`（環境変数 `ENVIRONMENT`、既定 `development`）を
`apps/api` / `apps/agent` / `apps/worker` の設定に導入し、`environment == production` のときだけ発火する
`model_validator`（fail-closed ガード）を `api` / `agent` の設定に追加する。

本番では次のいずれかを検知したら **起動時に例外を投げてコンテナを停止**（フェイルクローズ）する:

- `SESSION_SIGNING_SECRET` が空、または既知の弱デフォルト値
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` が既知デフォルト（`devkey` / `secret`）
- `AUTH_DEV_BYPASS` が有効
- `LOCAL_DIRECT_DISPATCH` が有効

Terraform は Cloud Run の `common_env` に `ENVIRONMENT = var.environment`（既定 `production`）を注入する。
これにより本番デプロイは常に production 判定となり、上記の脆弱な既定・バイパスのままでは起動できない。
`REQUIRE_LOGIN_NONCE` の Terraform 既定も `true`（fail-closed）に変更した（SEC-059/022）。

ローカル開発（`.env.example` / docker-compose）は `ENVIRONMENT=development` を明示し、
`AUTH_DEV_BYPASS=true` 等の開発利便を従来どおり享受する（`just up` を壊さない）。
dev バイパス経路自体はコードに残すが、本番では上記ガードにより有効化不能とする。

## 根拠 / 代替案

- **既定を production にして dev で緩める案**も検討したが、既存テストが `Settings()` を素の既定で多数構築し、
  `auth_dev_bypass` を monkeypatch する前提のため、既定 development の方が回帰リスクが低い。
  本番側は Terraform が明示的に `ENVIRONMENT=production` を注入する運用（IaC はレビュー必須）で担保する。
- 各分岐に個別ガードを撒く案は、抜け漏れと二重管理を生む。設定境界の一点集約の方が監査しやすい。

## 影響

- 本番で秘密未注入・バイパス有効のままデプロイすると起動失敗（意図した fail-closed）。
  デプロイ前に Secret Manager 由来の値注入を必須化する運用と整合（`docs/reference/security.md`）。
- 既存の開発・テストフローは `environment` 既定 development のため無変更。
- 本 ADR は監査対応の設計軸のみを記す。個別指摘（プロンプトインジェクションのフェンス化、
  PII マスクの永続化境界一律適用、入力サイズ/展開量ガード、CI 脆弱性ゲートのブロッキング化等）の
  事実と対応箇所は `security-audit/findings.md` と各コミット/PR 説明を正とする。
