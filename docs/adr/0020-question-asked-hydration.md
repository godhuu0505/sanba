# ADR-0020: question.asked のハイドレーション方式（サーバ保存 + GET 復元）

- ステータス: Accepted（方針確定。実装は WAVE2 / issue #212 フォローアップ）
- 日付: 2026-06-28
- 関連: ADR-0014（ログイン/管理画面・永続化境界）、リアルタイム契約 `docs/design/realtime-contract.md` §2/§4、PR #210（#181 実装）コメント [discussion_r3481382058](https://github.com/godhuu0505/sanba/pull/210#discussion_r3481382058)、issue #212、関連 #184/#100

## コンテキスト

通常質問の金枠ピン（`question.asked` / #181）は、web の `RealtimeStore.question` に**メモリ保持される
だけ**で、どの GET ハイドレーション・スナップショット（`/requirements`・`/detections`・`/context/files`）
にも含まれない一過性イベントである。そのため:

- **リロード / 途中参加**すると、未回答の問いピン（金枠）が**復元できない**。store は `question=null` から
  始まり、LiveKit データチャネルは**ライブ差分のみ**（既出の問いを再送しない）ため、復元手段が無い。
- `question.asked` は **seq 境界（`set_session_seq`）を進めない**（`apps/agent/.../main.py` の Codex P2
  対応コメント参照）。これは「ハイドレーション・スナップショットに含まれない一過性イベントで seq 境界を
  進めると、後続の再ハイドレーションで正当な差分を取り逃す」ための**意図的な設計**であり、維持すべき
  不変条件である。

既存ハイドレーション API は 3 本とも**同型**である（`apps/api/.../main.py`）:
**agent が Firestore に書く → API が `require_session_access()` で Bearer 検証して読む → web が GET で
スナップショット復元（契約 §4）**。`question.asked` だけがこの体系から漏れている。

> 本タスクのスコープは方式の**決定**のみ。実装コード変更・既存 3 API の仕様変更・seq 単調増加の
> 不変条件を崩す設計は **Out of Scope**。

## 決定

### 方式A（サーバ保存 + GET 復元）を採用。方式B（seq を進めない・再配信頼み）は却下

ただし issue #212 の方式A 素案（`POST /api/sessions/{id}/questions`）は、既存ハイドレーション API との
**一貫性最優先**の観点から下記に補正する。

#### 1. 書き込みは「agent が Firestore へ直接」（POST API は追加しない）
要件・検知は agent が `SessionRepository` で **Firestore に直接書き込み**、API は読み取り専用
（`ReadRepository`）である。POST 経路は存在しない。question も同じ責務分担に揃える:
- **ask_question 時**: 問いピンの「現在の未回答質問」を Firestore に保存（`id` / `prompt` / `options` /
  `asked_seq` = publish 時の envelope seq）。**最新1問のポインタ**として上書き保存する。
- **record_answer 時（回答済み）**: 現在質問を**クリア**する（回答済みの問いを再ハイドレーションで
  復活させない）。`user.answered`（#181）受信→記録の延長で行う。

→ issue 素案の `POST /api/sessions/{id}/questions` は採らない（agent 直書きの方が既存体系と一貫し、
api を経由する往復も不要）。

#### 2. 読み出しは GET を 1 本だけ追加（既存 3 GET と同型）
- `GET /api/sessions/{id}/questions/current` を追加。`require_session_access()`（Bearer / join 済み
  トークン）でガードし、`ReadRepository` で Firestore を読む。
- 返却: `{ question: {id, prompt, options} | null, seq }`。回答済み/未提示なら `question: null`。
- 既存 `/requirements`・`/detections`・`/context/files` と**完全に同じ認可・形**にする。

#### 3. seq の扱い — 不変条件は維持、ハイドレーションは `asked_seq` で順序付け
- `question.asked` で **session 境界 seq（`set_session_seq`）を進めない現行挙動は維持**する
  （単調増加の不変条件を崩さない＝Out of Scope の遵守）。
- GET が返す `seq` は保存した **`asked_seq`**（その問いが publish された時点の envelope seq）。web は
  ハイドレーション時に `store.question` を復元し、`lastQuestionSeq = asked_seq` を設定する。以後の
  ライブ `question.asked` は既存の seq ガード（`event.seq <= lastQuestionSeq` を破棄）で、**より新しい問い
  だけが置き換わり、古い再配信は負ける**。データチャネルの再配信には**依存しない**。

#### 4. 責務分担（web / agent / api）
- **agent**: 現在質問の永続化（ask 時）とクリア（answer 時）。`asked_seq` の付与。
- **api**: `GET /questions/current` の追加（読み取り専用 / Bearer 検証 / 観測性）。既存 3 API は不変。
- **web**: 接続/再接続時、購読開始後に他 GET と並べて `GET /questions/current` を呼び、
  `store.hydrateQuestion(question, asked_seq)` で金枠ピンを復元。

## 理由 / 検討した代替案

| 観点 | 採用: 方式A（サーバ保存 + GET） | 却下: 方式B（seq を進めない・再配信） |
|---|---|---|
| 既存体系との一貫性（最優先） | `/requirements`・`/detections`・`/context/files` と完全同型（agent 書き / API 読み / GET 復元） | question だけ「再配信で復元」の例外方式。契約 §4 の「GET で取り直す」体系を割る |
| 途中参加 | 一度も受信していない参加者も GET で即復元 | **救えない**（再配信は既存購読者へのライブ差分前提） |
| リロード復元の確実性 | GET で確定的に復元 | agent の次 publish 任せで不定。いつ再送されるか保証が無い |
| seq 不変条件 | `set_session_seq` を進めない現行挙動を維持（不変条件を崩さない） | 「seq を進めない」を再配信成立の前提にし、store の seq ガード/整列の例外を question に作る |
| store 改修 | 追加（`hydrateQuestion`）のみ。既存ガードを再利用 | 「古い再配信で最新へ正しく上書き」する追加ロジックが必要で、冪等・整列の前提が揺らぐ |
| 観測性 | 既存 GET と同じ API トレース＋`question_hydrated` ログ/メトリクス | ライブ再配信の取りこぼし調査が難しい |

- **一貫性最優先（共通制約）**: 既存ハイドレーション API の同型を崩さないことが最大の根拠。方式B は
  「再配信を許容するために seq を進めない」という、契約 §4 のスナップショット復元モデルから外れた
  例外を 1 イベント型にだけ作る。
- **不変条件の保全**: 現行コードは既に「question.asked は seq 境界を進めない」を**意図的に**実装済み。
  方式A はこれをそのまま活かし、ハイドレーションは別軸（保存した `asked_seq`）で順序付けるため、
  単調増加の前提を一切触らない。

## 影響 / フォローアップ（WAVE2: issue #212）

実装は本 ADR の合意後に別 PR で行う（本タスクではコードを変更しない）。作業分解:

1. **共有/agent**（`packages/sanba_shared/.../repository.py`、`apps/agent/.../events.py`・`main.py`）:
   現在質問の保存（`sessions/{id}` に `current_question` フィールド or サブコレクションの単一ポインタ、
   `asked_seq` 付き）を `ask_question` に、クリアを `record_answer`（回答時）に追加。
2. **API**（`apps/api/.../repository.py`・`main.py`）: `ReadRepository.get_current_question()` と
   `GET /api/sessions/{id}/questions/current`（`require_session_access` / レスポンス schema /
   `question_hydrated` ログ・メトリクス）を追加。**既存 3 API は変更しない**。
3. **Web**（`apps/web/lib/realtime/store.ts`・`useRealtimeSession.ts`）: `hydrateQuestion(question, seq)`
   （`this.question` 復元 + `lastQuestionSeq = seq`）と、接続時 GET の結線（他 GET と同じ順序）。
4. **テスト**: agent の保存/クリア単体、API GET 単体（Bearer 必須 / 未提示・回答済みで null）、
   web store の `hydrateQuestion`（古いライブは破棄・新しい問いで置換）の単体。
5. **観測性**（CLAUDE.md 原則3 / 契約 §5）: `requirements_hydrated` と同様に件数・有無を計測。

## 却下案

- **方式B（seq を進めない・再配信頼み）**: 途中参加を救えず、リロード復元が不定、契約 §4 の GET 復元
  体系から外れる。非推奨。
- **issue 素案の `POST /api/sessions/{id}/questions`**: API に書き込み往復を増やし、agent 直書きの
  既存パターン（要件/検知）から外れる。agent 直書き + GET 1 本の方が一貫する。
- **全質問履歴のサブコレクション化**: 監査用途では有用だが、UI は「最新1問」モデル。MVP は現在質問
  ポインタで十分。履歴保持は将来 issue 化。

## 保留（未解決リスク）

- 「最新1問」ポインタのため、複数の未回答質問を同時に並べる UI へは未対応（現行 UI 仕様どおり）。
- 現在質問ドキュメントの TTL は未設計。発話/draft 要件の 30 日 TTL（ADR-0014）と整合させるか、
  セッション finalize 時にクリアするかは実装時に決める。

> 本書は設計判断の記録（提案）。最終採否は人間レビューを経る（CLAUDE.md 原則1）。
