# セキュリティポリシー — SANBA

SANBA は音声で要件をヒアリングする性質上、会話に PII が含まれうるため、
セキュリティとデータガバナンスを最優先で扱います。

## 脆弱性の報告

**脆弱性は公開 Issue に書かないでください。** 次のいずれかで非公開に報告してください。

- GitHub の **[Security Advisories](https://github.com/godhuu0505/sanba/security/advisories/new)**（推奨。"Report a vulnerability"）
- それが使えない場合は、[@godhuu0505](https://github.com/godhuu0505)（GitHub プロフィールより DM）へ直接連絡。

報告には、再現手順・影響範囲・想定される深刻度を含めてください。
受領後すぐに確認し、修正方針と公開タイミングを相談します。

## 対応方針

- 受領を速やかに確認し、深刻度（P0/P1/P2）を評価します。
- 修正は段階的に進め、advisory は順次解消します。
- 報告者のクレジットは希望に応じて記載します。

## このプロジェクトのセキュリティ対策

- **CI セキュリティスキャン**: pip-audit / npm audit / gitleaks / Trivy（[`.github/workflows/security.yml`](.github/workflows/security.yml)）、CodeQL（[`codeql.yml`](.github/workflows/codeql.yml)）、Dependabot。
- **シークレット管理**: `.env`（gitignore 済）と Secret Manager。gitleaks がコミット混入を検出。
- **PII マスキング**: 会話・資料は索引前にマスク（既定 ON）。
- **アクセス制御**: 署名付き招待トークン、TTL 付き LiveKit トークン、レート制限。
- **最小権限**: Cloud Run のランタイム SA は最小権限、コンテナは非 root・最小ベース。

設計・データ取り扱いの詳細は [`docs/reference/security.md`](docs/reference/security.md) を参照してください。
