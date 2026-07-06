# ハッカソン提出 チェックリスト & 手順書（#41）

> **DevOps × AI Agent Hackathon 2026 の提出を完了させるための、人手作業の手順書。**
> コード/文章側で自動化・準備できるものは別途用意済み（下表）。ここに書くのは
> **実 creds・外部アカウント・録画・フォーム提出・本番稼働確認**という「人間にしかできない」作業。
>
> **提出締切: 2026-07-10（金）23:59。** STEP①〜③を全て完了して初めて「正式エントリー」。1 つでも欠けると未提出扱い。

## 準備済み（このリポジトリ内）

| 成果物 | 場所 | 用途 |
|---|---|---|
| ProtoPedia ページ原稿 | `docs/hackathon/protopedia-page.md` | STEP② に貼る本文 |
| デモ動画 台本・絵コンテ | `docs/hackathon/demo-video-script.md` | P0-1 録画・動画編集 |
| アーキテクチャ / DevOps 図（PNG 書き出し済み） | `docs/hackathon/assets/architecture.png` / `devops-cycle.png` | STEP② に画像アップロード |
| 審査基準の分析 | `docs/hackathon/judging-criteria-strategy.md` | 記事・ピッチの軸出し |
| E2E 疎通の現状整理 | `docs/hackathon/e2e-verification-2026-06-15.md` | どこが fallback かの把握 |

---

## 必須提出物（3 点すべて）

- [x] **GitHub 公開リポジトリ URL** … `https://github.com/godhuu0505/sanba`（public 済み）
- [ ] **デプロイ済み URL**（審査員がその場で動作確認できる状態）… → **P0-3**
- [ ] **ProtoPedia 作品ページ URL** … → **STEP②**

---

## STEP①: Findy Conference で参加登録（全員必須）

> チーム参加なら**全員が個別に**登録必須。1 人でも未登録だと未提出扱い。

1. エントリーフォームを開く: <https://conference.findy-code.io/conferences/DevOps-AI-Agent-Hackathon/30/streamings>
2. 参加登録を完了する（チームメンバー各自）。
3. 参加資格の確認: 日本居住・18 歳以上・**私的活動**としての参加（業務参加・公務員等は不可）。チームは 1〜5 名。
- [ ] 自分の登録完了
- [ ] （チームの場合）全メンバーの登録完了を確認

---

## P0-1: 実 creds で 1 経路を E2E 疎通させて録画する

> **なぜ最優先か**: 全外部依存が「未設定なら graceful fallback」で実装されているため、実 creds を繋いだ
> 本物の経路が一度も通っていない（`e2e-verification-2026-06-15.md`）。「本物が動いた証拠」が審査の土台。
> ペルソナは「**個人開発者の壁打ち（1:1）**」1 本に絞る。

### 方法 A: 本番（Cloud Run）で録画（推奨・P0-3 と兼ねられる）

本番が稼働していれば、審査員向け URL でそのまま録画するのが最短。稼働確認は P0-3 を先に。

### 方法 B: 実 creds のローカルで録画

```bash
# 1. セットアップ（初回のみ）
just setup                      # .env.local を生成

# 2. .env.local に実 creds を設定（最低限これだけで 1:1 音声＋ADK＋Firestore が本物になる）
#   GOOGLE_API_KEY=<AI Studio のキー>           # Gemini Live / Vision / Reasoning / Embedding
#   GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio   # ※下の「モデル注意」参照
#   LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET     # LiveKit Cloud か devkey/secret
#   （ES・Firestore は just up で起動する emulator/実体をそのまま使える）

# 3. 起動
just up                         # web/api/agent/livekit/firestore/elasticsearch
just verify                     # 疎通スモーク

# 4. ブラウザで録画開始（画面＋マイク＋システム音声）
open http://localhost:3000      # セッション作成 → 参加 → 実機マイクで話す
#   - エージェントが音声で問い返す（S2S が本物）
#   - 画像アップロードで「言葉×画の矛盾」検知が出る
#   - 右ペインに要件がリアルタイム構造化される
open http://localhost:3000/admin  # 人間が要件を承認 → GitHub Issue 起票（要 GITHUB_* 設定）
```

**「本物であること」の確認ポイント（fallback に落ちていないこと）**
- [ ] `GOOGLE_API_KEY` で Gemini Live S2S 音声対話（barge-in 含む）が成立
- [ ] `analyze_requirements` で **ADK マルチエージェントが実呼び出し**される（ヒューリスティック近似ではない）
- [ ] 確定要件が Firestore（emulator 可）に永続化される
- [ ] Web に要件がリアルタイム可視化される
- [ ] 通った録画（生データ）と再現手順を `docs/hackathon/` に残す

**モデル注意（本番で既知の落とし穴・PR #311 で対応済み）**: Vertex 経路では `gemini-2.0-flash-live-001` は
`1008 "Publisher model not found"` でクラッシュする。本番 terraform 既定は `gemini-live-2.5-flash-native-audio`。
ローカルで AI Studio(API キー)経路なら `gemini-2.0-flash-live-001` でも可だが、本番と揃えるなら native-audio を使う。

**録画ツール**: macOS は QuickTime（画面収録＋内蔵/外部マイク）か、OBS（システム音声も録れる）。
編集で `demo-video-script.md` の 7 カットに沿って 60 秒に詰める。

---

## P0-3: デプロイ URL が審査員の手元で動く状態にする（必須提出物②）

> 現状 README は公開 URL <https://youken.sanba.net> を掲げている。**締切前に実際に叩いて稼働を再確認**する。
> 最新 deploy が pending で停滞していないか、main の最新が反映されているかを見る。

1. **最新デプロイの状態確認**（GitHub Actions → `deploy.yml` の最新 run が success か）。
   - pending/failure なら手動 dispatch でやり直す。手順は `docs/runbooks/deploy-gcp.md`。
2. **外部から疎通**（別ネットワーク／スマホ回線などで）:
   - [ ] `https://youken.sanba.net` が開く（web）
   - [ ] `/login` → Google ログイン（または dev 導線）が動く
   - [ ] セッション作成 → 音声で往復できる（S2S）
   - [ ] 画像アップロード → 解析が返る
   - [ ] 要件がリアルタイムに出る
3. **審査員導線**: アカウント作成やローカル設定なしで触れる導線を用意する。
   - [ ] デモ用ルーム／ゲスト導線（ADR-0032 のゲスト参加リンク）を 1 本発行して README/ProtoPedia に載せる
   - [ ] 触れない場合に備え、P0-1 の録画を「動作証拠」として併記
4. **掲載**: 稼働 URL を **ProtoPedia と README の両方**に載せる。
- [ ] 本番稼働を外部から確認
- [ ] 審査員が触れる導線 or 録画を用意
- [ ] URL を ProtoPedia・README に掲載

> **agent 常駐の注意**（`docs/devops.md §8`）: 初期構築の本番は CI が `AGENT_MIN_INSTANCES=0` に上書きするため
> ワーカー非常駐。音声を実接続で審査させるなら GitHub Variable `AGENT_MIN_INSTANCES=1` を設定して常駐させる。

---

## STEP②: ProtoPedia に作品ページを作成・登録

> 提出先は **ProtoPedia**（Zenn ではない）。GitHub URL / デプロイ URL / 概要 / 図 / デモ動画を載せる。

### a. 本文を貼る
1. ProtoPedia でプロトタイプを新規作成（要 ProtoPedia アカウント）。
2. `docs/hackathon/protopedia-page.md` の本文を作品説明に貼る。`{{...}}` を実値へ差し替える:
   - `{{デモ動画埋め込み}}` … P0-1 で撮った 1 分動画（YouTube 限定公開推奨）
   - `{{デプロイ URL}}` … P0-3 で確認した稼働 URL

### b. 図を画像アップロード（ProtoPedia は Mermaid を描画しない）
図は **`docs/hackathon/assets/architecture.png` / `devops-cycle.png` に書き出し済み**。そのまま ProtoPedia に
アップロードすればよい。図を編集して作り直す場合のみ、`protopedia-page.md §3/§4` の Mermaid を更新して再生成:
- **手軽**: <https://mermaid.live> に Mermaid を貼り付け → PNG/SVG エクスポート。
- **CLI**: `npx -p @mermaid-js/mermaid-cli mmdc -i in.mmd -o architecture.png -w 1600 -b white`。

### c. 必須要素の最終チェック（記事に必ず含める）
- [ ] 対象ユーザー・解決する課題（原体験ストーリーを冒頭に）
- [ ] 「なぜ AI エージェントなのか」の必然性
- [ ] アーキテクチャ図（GCP サービスとデータフロー）
- [ ] DevOps サイクル図（CI/CD・LLMOps・観測性・**Four Keys**）
- [ ] 設計判断の理由 / やめた選択肢（ADR リンク）
- [ ] 「人間が品質に責任を持つ」ことの明示
- [ ] ロードマップ／効くフレーズ
- [ ] 1 分以内のデモ動画を埋め込み
- [ ] GitHub URL・デプロイ URL を掲載
- [ ] 公開設定を確認し、**作品ページ URL を控える**（STEP③ で使う）

---

## STEP③: Google Form の作品提出フォームから最終応募

1. 応募ページ経由で作品提出フォーム（Google Form）を開く。入口はイベントページ:
   - connpass: <https://findy-tools.connpass.com/event/392105/>
   - Google Cloud 公式ブログ: <https://cloud.google.com/blog/ja/products/ai-machine-learning/devops-ai-agent-hackathon-2026>
2. 必須 3 点を入力: **GitHub URL / デプロイ URL / ProtoPedia URL**。
3. 送信 → 正式エントリー完了。
- [ ] フォーム送信完了（これで STEP①②③ が揃い「正式エントリー」）

---

## 任意（加点狙い・P0 が揃ってから）

- **P1 Zenn/note 解説記事**: 審査員に Zenn 運営者がいるため加点見込み（`judges-analysis.md`）。ProtoPedia の内容をベースに読み物化。
- **P2 LLMOps 回帰の数値**: 実 Gemini で評価データセットを回し、プロンプト改善の before/after を NFR カバレッジ／具体性／矛盾処理の 3 軸で提示。Langfuse でトレース・評価・プロンプトバージョンを可視化。決勝ピッチの「まわす」の説得力に効く。

---

## 提出直前の総点検（締切当日）

- [ ] STEP① 全員登録済み
- [ ] P0-3 デプロイ URL が**いま**外部から動く
- [ ] STEP② ProtoPedia ページ公開・URL 確定・図と動画入り
- [ ] STEP③ Google Form 送信済み
- [ ] README のデモ節・稼働 URL が最新（動画リンク差し替え済み）
- [ ] 公開物にシークレット/PII の映り込みが無い
