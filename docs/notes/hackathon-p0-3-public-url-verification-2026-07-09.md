# P0-3 公開 URL 外形疎通確認（2026-07-09）

- ステータス: **一時作業文書**（日付付き検証 / ADR-0050 原則4。着地後アーカイブ）
- 対象: epic #41 P0-3「提出時点でデプロイ URL が審査員の手元で動く状態にする」
- スコープ: **外側（ブラウザ/HTTP）からの機械的な外形疎通確認**のみ。音声 S2S の実往復・要件生成の実動は本書の対象外（実機マイクが要るため P0-1 の別トラックで実施）。
- 検証時点: 2026-07-09 06:22 JST / 対応 `main` = `024b426`（PR #458 マージ後）
- 実施: 外部ネットワークから `curl`（無認証）＋ `gcloud`（sanba-prd / us-central1）

## 結論

- 公開 URL **https://youken.sanba.net** は外部から稼働（web トップ / `/login` とも HTTP 200・Managed SSL 検証 OK）。
- API 公開ホスト **https://api.youken.sanba.net** の `/healthz` が 200 `{"status":"ok"}`。
- 認証必須エンドポイントは無トークンで **401** を返し、認可ゲートが効いている。
- Cloud Run 4 サービスとも**最新 ready リビジョンが 100% トラフィック**を配信し、最新 `main`（`024b426`）がデプロイ済み。
- API サービスは run.app 直アクセスを遮断（LB 経由のみ）。公開経路は LB + Managed SSL に一本化されている。

→ P0-3 の「停滞 deploy を復旧し最新 main を配信」「公開 URL に外部から疎通」は**達成**。残る「音声/画像/要件生成の主要フロー実動」と「審査員向けゲスト導線」は下記「残課題」を参照。

## エビデンス

### 1. 到達性・TLS（web）

| URL | HTTP | TLS 検証 | 応答 |
|---|---|---|---|
| `https://youken.sanba.net/` | 200 | OK (0) | ~0.33s |
| `https://youken.sanba.net/login` | 200 | OK (0) | ~0.25s |
| `https://sanba-web-...-uc.a.run.app/`（直） | 200 | OK (0) | ~0.29s |

### 2. API ヘルス・公開境界

| URL | HTTP | 意味 |
|---|---|---|
| `https://api.youken.sanba.net/healthz` | 200 `{"status":"ok"}` | 公開 API が LB 経由で生存 |
| `https://sanba-api-...-uc.a.run.app/healthz`（直） | 404 | ingress を LB 経由に制限（run.app 直アクセスは遮断）＝想定どおりの姿勢 |

> 公開境界（ADR-0050 原則8）: run.app のサービスホスト名は `gcloud run services list` で誰でも得られる**非秘匿の公開エンドポイント**であり、かつ ingress 制限で直アクセスは 404 に遮断済みのため、PUBLIC リポジトリへの記載を許容する（秘匿情報・PII ではない）。再現手順ではプロジェクト固有ホストを実値で示すが、本文の表では `...` で伏せている。

### 3. 認可ゲート（無トークン GET → 401 期待）

| URL | HTTP | body |
|---|---|---|
| `https://api.youken.sanba.net/api/sessions/mine` | 401 | `{"detail":"missing bearer token"}` |
| `https://api.youken.sanba.net/api/products/mine` | 401 | `{"detail":"missing bearer token"}` |
| `https://api.youken.sanba.net/api/member-invites/mine` | 401 | `{"detail":"missing bearer token"}` |

### 4. 配信リビジョン（Cloud Run / sanba-prd / us-central1）

| サービス | 配信リビジョン | トラフィック |
|---|---|---|
| sanba-web | `sanba-web-00092-lcv` | 100%（latest） |
| sanba-api | `sanba-api-00064-lpp` | 100%（latest） |
| sanba-agent | `sanba-agent-00071-ckd` | 100%（latest） |
| sanba-worker | `sanba-worker-00014-mkx` | 100%（latest） |

直近の CD `Deploy (Cloud Run)` は `024b426`（PR #458）で success（UTC 16:59:57 完了）。その前段 `928a586`（PR #452）も success（UTC 16:15:15）。いずれも `gh-deployer@sanba-prd.iam.gserviceaccount.com` が反映。

## 再現手順

```bash
# 1. web 到達性・TLS
curl -sS -o /dev/null -w "HTTP %{http_code} TLS %{ssl_verify_result} %{time_total}s\n" \
  -L https://youken.sanba.net/
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -L https://youken.sanba.net/login

# 2. API ヘルス（公開ホスト）と run.app 直アクセス遮断
curl -sS -w "\nHTTP %{http_code}\n" https://api.youken.sanba.net/healthz
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://sanba-api-vvvsuzhyma-uc.a.run.app/healthz  # → 404

# 3. 認可ゲート（無トークン → 401）
for p in /api/sessions/mine /api/products/mine /api/member-invites/mine; do
  curl -sS -w " [HTTP %{http_code}]\n" "https://api.youken.sanba.net$p"
done

# 4. 配信リビジョン・トラフィック
gcloud run services list --project sanba-prd --region us-central1 \
  --format 'json(metadata.name,status.latestReadyRevisionName,status.traffic)'
```

## 観測事項・残課題

- **[P0-1 で実施] 音声/画像/要件生成の主要フロー実動**: 本書は外形（到達性・ヘルス・認可ゲート）までを保証する。Gemini Live S2S の実往復・資料解析・要件のリアルタイム可視化・Firestore 永続化は実機マイクが要るため P0-1（実 creds 1 周の録画）で確認する。
- **[要対応] 審査員向けゲスト導線**: アカウント作成・ローカル設定なしで触れる導線（ゲスト/デモ用ルーム or デモ動画）の用意は本書の対象外。P0-2（ProtoPedia + デモ動画）と合流して整える。
- **[観測] セキュリティレスポンスヘッダ**: web 応答に `Strict-Transport-Security` 等が確認できなかった（LB/Cloud Run のヘッダ付与を要確認）。P0-3 のブロッカーではないが、公開ハードニング（epic #287）で追う。
- **[運用] 検証は点断面**: `main` は開発が進行中で、リビジョンは随時更新される（本検証中も #458 で web が 00091→00092 へ更新）。本書は 2026-07-09 06:22 JST 時点のスナップショット。

## 参照

- epic #41（P0-3）/ epic #287（公開ハードニング）
- `docs/how-to/deploy-gcp.md`（デプロイ手順）/ `infra/terraform/domain.tf`（LB・ホスト・公開境界）
- `README.md`（公開 URL 記載）
