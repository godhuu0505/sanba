# ADR-0013: 本番ドメイン (sanba.com) を Global 外部 HTTPS LB で配信

- ステータス: Accepted
- 日付: 2026-06-19
- 関連: ADR-0006 (Cloud Run 継続) / runbook `docs/runbooks/deploy-gcp.md`

> **更新 (2026-06-24): ドメインはコードに焼かず設定駆動にし、web をサブドメインへ置く構成を追加。**
> 本リポジトリは OSS (public) なので、特定ドメインを「本番」として固定しない。`var.domain` と
> 新設の `var.web_subdomain` でデプロイ側が各自設定する。**アーキテクチャの決定 (LB 方式) は変更なし**。
> メンテナ環境は `domain="sanba.net"` / `web_subdomain="youken"` (= ログインは `https://youken.sanba.net`)
> を一例として使う。詳細は末尾「更新」を参照。以下の本文は当時の記録として `sanba.com` のまま残す。

## コンテキスト
本番 URL を Cloud Run 既定の `*.run.app` から独自ドメイン **sanba.com** に変更したい。
Cloud Run へ独自ドメインを当てる方法は 2 つある。

1. **Cloud Run ドメインマッピング** (`google_cloud_run_domain_mapping`)
   - 設定は最小。だが一部リージョンのみ・プレビュー扱いの機能制約があり、WAF/CDN を前段に
     置けない。複数サービス (web/api) を 1 証明書・1 IP に集約しにくい。
2. **Global 外部 Application Load Balancer + Serverless NEG + Google 管理 SSL 証明書**
   - 安定した Anycast IP を確保でき、Cloud Armor (WAF) / Cloud CDN への拡張余地がある。
   - host ベースで `sanba.com`/`www`/`api.sanba.com` を 1 つの LB に集約できる。

## 決定
**方式 2 (Load Balancer + 管理証明書) を採用**する。CLAUDE.md の「本番志向 (production-ready)」
原則に合致し、後から WAF/CDN を足せる拡張性を優先した。

- 配信構成:
  - `sanba.com` / `www.sanba.com` → `sanba-web` (Serverless NEG)
  - `api.sanba.com` → `sanba-api` (Serverless NEG)
  - HTTP(80) は 301 で HTTPS(443) にリダイレクト。
- 証明書は Google 管理 (apex + www + api の 3 ドメイン)。A レコードが LB IP を指すと自動発行。
- DNS は Cloud DNS で管理 (`manage_dns=true`)。ゾーンの NS をレジストラに設定する。
- IaC: `infra/terraform/domain.tf`。`var.domain` が空なら LB を一切作らず従来どおり
  `*.run.app` 運用 (既存環境を壊さない安全な既定)。
- CORS: web(sanba.com) → api(api.sanba.com) は別オリジンになるため、`ALLOWED_ORIGINS` を
  `https://sanba.com,https://www.sanba.com` に切り替える (`cloud_run.tf`)。

## 影響 / 手作業前提
- **ドメイン取得は手作業**。取得後にレジストラの NS を Cloud DNS の NS (`terraform output
  dns_name_servers`) へ向ける必要がある。
- 管理証明書の発行は DNS 伝播後で数分〜最大数十分かかる (`PROVISIONING` → `ACTIVE`)。
- web ビルドの `NEXT_PUBLIC_API_URL` を `https://api.sanba.com` に更新して再デプロイする。
- `sanba.jp` も将来当てる場合は `cert_domains` / host_rule の拡張で対応可能 (本 ADR の範囲外)。

## 検討したが採用しなかった選択肢
- **ドメインマッピング**: 最小構成だが WAF/CDN 不可・機能制約。本番運用の拡張性で却下。
- **外部 DNS をそのまま使う (`manage_dns=false`)**: 可能だが、Cloud DNS に寄せると A レコードを
  Terraform で宣言的に管理でき、IaC 一貫性が高い。既定は Cloud DNS 管理とした。

## 更新 (2026-06-24): 設定駆動化 + web サブドメイン配信を追加

- **背景 (OSS)**: 本リポジトリは public なので、配信ドメインを特定値に固定しない。`var.domain`
  (apex) と新設 `var.web_subdomain` でフォーク先が各自のドメインを設定する。元の `sanba.com` 想定は
  取得不可（`.com`/`.app`/`.ai`/`.dev` いずれも不可）だったため、メンテナ環境は登録可能な `sanba.net`
  を apex に使い、ログインは `youken.sanba.net` に置く構成を一例として採用する。
- **新設 `var.web_subdomain` の挙動** (`infra/terraform/domain.tf`):
  - **空 (既定)**: 従来どおり apex 配信。web=`<domain>`/`www.<domain>`、api=`api.<domain>`。
  - **設定時** (例 `"youken"`): web=`youken.<domain>`、api=`api.youken.<domain>`、apex と `www` は
    web へ **301 リダイレクト**（HTTPS 上の host redirect）。
  - 証明書・Cloud DNS A レコードは「LB で終端する全ホスト」(`local.lb_hostnames`) を自動でカバーする
    ため、モード切替で証明書/レコードも追従する。
- **メンテナ環境の配信構成**:
  - `youken.sanba.net` → `sanba-web`
  - `api.youken.sanba.net` → `sanba-api`
  - `sanba.net` / `www.sanba.net` → `youken.sanba.net` へ 301
- **HSTS preload**: `.net` は HSTS preload TLD では**ない**（`.app` / `.dev` と異なり、証明書発行前
  でも HTTP は通常どおり応答する）。したがって `.app`/`.dev` 特有の「証明書 ACTIVE まで一切閲覧不可」
  という制約はない。
- **ログイン**: Google ログイン (ADR-0012) を成立させるには、OAuth クライアントの**承認済み
  JavaScript 生成元**に web を配信するオリジン（メンテナ環境では `https://youken.sanba.net`）を
  追加する必要がある（runbook §6.5 D）。apex/www は 301 されるためオリジンにはならず、`ALLOWED_ORIGINS`
  にも web ホストのみ入れる。忘れると GIS が `origin not allowed` で失敗する。
- **実装影響**: 配信ロジックは `var.domain` / `var.web_subdomain` 駆動。`ALLOWED_ORIGINS` も
  `local.web_hosts` から自動生成。CI は `PROD_DOMAIN` / `PROD_WEB_SUBDOMAIN` (GitHub Variables) で渡す。
- **手順**: runbook `docs/runbooks/deploy-gcp.md` §6.5 に A→G の詳細手順を記載。
