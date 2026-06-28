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
  `asked_seq` = その問いの envelope seq）。**最新1問のポインタ**として上書き保存する。**送信前に確定する**
  （順序は §5-1 を厳守。data-channel publish 成功 → 保存完了の間に復元できない窓を作らない）。
- **回答時**: 現在質問を**クリア**する（回答済みの問いを再ハイドレーションで復活させない）。**現在質問 id が
  回答対象 `question_id` と一致するときのみ**、かつ **transaction/CAS で原子的に**クリアする（§5-3 / §5-7）。
  options なしの自由記述（`user.text`/音声）回答もクリア契機にする（§5-6）。クリアは全参加者へ `question.cleared`
  で伝播する（§5-5）。

→ issue 素案の `POST /api/sessions/{id}/questions` は採らない（agent 直書きの方が既存体系と一貫し、
api を経由する往復も不要）。

#### 2. 読み出しは GET を 1 本だけ追加（既存 3 GET と同型）
- `GET /api/sessions/{id}/questions/current` を追加。`require_session_access()`（Bearer / join 済み
  トークン）でガードし、`ReadRepository` で Firestore を読む。
- 返却: `{ question: {id, prompt, options} | null, seq }`。回答済み/未提示なら `question: null`。
  **`question: null` のときも `seq` を返す**（クリア時点の seq＝`cleared_seq`）。web はこの順序情報で
  「遅延 null が新しい live 質問を消す」事故を防ぐ（§5-4）。
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
  `store.hydrateQuestion(question, seq)` で金枠ピンを復元。

#### 5. 順序・冪等の保証（Codex レビュー #230 反映）

確定的な復元を成立させるため、実装が満たすべき不変条件を明記する。これらは方式Aの決定を変えず、
contract を締めるための条件である。

**5-1. 「保存してから publish」を厳守（送信前に GET 可能にする）。**
現行 `EventPublisher._emit` は seq 採番直後に送信する（`apps/agent/.../events.py:114-124`）。素直に
「publish 後に Firestore 保存」とすると、**送信成功〜保存完了の窓**でリロード/途中参加が起きたとき、
LiveKit は既出イベントを再送せず GET はまだ `null` を返し、復元が失敗する。これを防ぐため:
- 送る envelope の seq を**事前採番（予約）**し、その seq を `asked_seq` として **Firestore 保存を完了して
  から** `question.asked` を data-channel へ送る。順序は **採番 → 保存 → 送信**。
- 実装上は publisher に「次 seq の予約」または「現在質問スナップショットを送信前に永続化するフック」を
  設け、保存と送信を同一クリティカルセクション（既存の seq 採番ロック内）で順序付ける。保存失敗時は
  送信しない（復元できないイベントを表に出さない）。
- **保存失敗で seq 欠番を作らない**: 「事前採番」は publisher のカウンタを**先にインクリメントしない**こと。
  `self._seq + 1` を**覗くだけ**で確定させず、保存成功後に送信する瞬間まで採番を確定する（または保存失敗時に
  予約をロールバックする）。これを怠ると、保存失敗で送らなかった seq が**永久欠番**になり、次の live イベントで
  web が存在しない差分を欠番検知して不要な再ハイドレーションを起こす。

**5-2. `hydrateQuestion` は条件付き適用 + `maxSeq` も進める（誤 gap・巻き戻しを防ぐ）。**
store は `maxSeq` を基準に欠番検知する（`apps/web/.../store.ts:199-203`）。`asked_seq=N` を GET で復元した
直後に live `N+1` が来ると、復元済みの `N` を未受信扱いして不要な gap/再ハイドレーションを誘発する。
`hydrateQuestion(question, seq)` は:
- **非 null 復元も `seq > lastQuestionSeq` のときだけ適用**する（古い current question を読んだ遅延 GET レスポンスが
  後着して、先に適用済みの新しい live `question.asked` を古い問いへ巻き戻すのを防ぐ）。適用時に `this.question` /
  `lastQuestionSeq` を更新する。
- 適用の有無に関わらず **`maxSeq = Math.max(maxSeq, seq)`** を進める（誤 gap 防止）。ただし**主スナップショット
  （`/requirements`）が成功した hydration パスに限る**（§5-11。主 GET 失敗時は question 由来 seq で global `maxSeq` を
  進めず gap/retry を残す）。
- `hydrationSeq`（live 破棄境界）は question が seq 境界を進めない方針（§3）に合わせて**触らない**
  （他 GET と異なり question 専用の境界は作らない）。

**5-3. 回答クリアは id 一致時のみ（古い回答で新しい問いを消さない）。**
§1 のとおり `record_answer` は **Firestore の現在質問 id == 回答対象 `question_id` のときだけ**クリアする。
複数参加者・再送で古い `user.answered` が遅れて届いても、その後に出た新しい未回答質問のポインタは保つ。

**5-4. `null` 復元にも順序情報を持たせる（遅延 null で新しい問いを消さない）。**
GET は `question: null` のときも `seq`（クリア時点の `cleared_seq`）を返す。web は **GET の `seq` が
`lastQuestionSeq` より新しいときだけ** null を適用してピンを畳む。これにより「切断中に別参加者が回答
→ current クリア」を安全に反映しつつ、「GET 開始後に届いた新しい live `question.asked` を、遅れて返った
null レスポンスが消す」逆転を防ぐ。`cleared_seq` はクリア時点の publisher seq を採番して付与する。
null を適用したときも **`maxSeq` と `lastQuestionSeq` の両方を `cleared_seq` まで進める**（§5-10。`maxSeq`
だけだと、別の遅い GET が `question seq < cleared_seq` で後着したとき §5-2 の `seq > lastQuestionSeq` を満たして
クリア済みの問いを復活させる）。

**5-5. 回答クリアを接続中の全員へ伝播する（重複回答を防ぐ）。**
`record_answer` で Firestore のポインタを消すだけだと、web は GET を接続/再接続/欠番時にしか実行しないため、
回答した本人以外の同室参加者は新しい `question.asked`/gap が来ない限り**古い金枠ピンを表示し続け**、重複回答を
送れてしまう。クリアは全参加者へ伝播させる: realtime 契約に **`question.cleared`（live イベント / `question_id` +
`cleared_seq`）を追加**し（WAVE2・契約 §2 への追記）、web は **§5-10 のガード条件を満たすときだけ**当該ピンを畳む
（無条件には畳まない）。`question.cleared` は seq 境界を進めない点で `question.asked` と対称に扱う（§3）。
※既存 3 API・既存イベントの仕様は変えない（新規追加のみ）。
- **`cleared_seq` を二重採番しない**: `cleared_seq` は **`question.cleared` の envelope `seq` そのもの**にする
  （payload に別採番した値を載せて `_emit` がさらに envelope seq を進めると、1 回のクリアで `cleared_seq=N` と
  `event.seq=N+1` の 2 連番を消費し、GET=N / live=N+1 が食い違って存在しない N を欠番検知する）。§5-1 と同じく
  envelope seq を**一度だけ予約**し、その同一値を Firestore tombstone の `cleared_seq`・`question.cleared` の seq・
  GET が返す seq の**すべてに使う**。

**5-6. 音声/テキスト回答でも current question をクリアする（options の有無に依らず）。**
クリア契機を `user.answered`（タップ）受信に限定すると漏れる: `ask_question` は音声問いかけと併用され**タップは補助動線**
であり、`options` ありの問いでも参加者は声やボトムバー `user.text` で答えうる。これら音声/テキスト回答には
`question_id` が無いため `record_answer` に到達せず、回答済みの問い（options あり/なし双方）が Firestore に残り、
リロード/途中参加で復活する。対応方針: agent は**現在 current question が未回答の間に届いた `user.text`/音声発話を、
その current question への回答とみなして対応付け、クリアする**（最新1問モデルでは「次の発話＝直近の問いへの応答」が
自然）。**options の有無に関わらず**この「未回答 current への次回答」経路でクリアし、`user.answered`（タップ）の
`question_id` 一致（§5-3）は**追加の早期クリア経路**として併存させる。
- **no-id 経路もクリア対象 id を固定する**: `user.text`/音声には `question_id` が無いため、**発話受信時点の current
  question id を束ねて**から、その id で §5-7 の CAS クリアを行う。受信後の非同期処理が遅れる間に別経路で current が
  `q2` に上書きされても、束ねた `q1` id と一致しなければクリアしない（遅い q1 回答処理が q2 を誤って tombstone 化
  するのを防ぐ。タップ経路の §5-3/§5-7 と同じ id 照合保護を no-id 経路にも効かせる）。

**5-7. id 照合とクリアは原子的に（transaction / CAS）。**
§5-3 の id 一致確認を「読み取り → null 書き込み」の別操作で実装すると、古い回答処理が一致を読んだ直後に
新しい `ask_question` がポインタを上書きし、その後の古い処理のクリアが**新しい問いを消す**競合が起きる
（複数 `user.answered` や再送の並行時）。**id 照合とクリアは Firestore transaction / CAS（条件付き削除）で
同一操作にする**。`ask_question` の上書き保存も同じドキュメントを触るため、最終的な勝者が一意に決まるよう
read-modify-write をトランザクション化する。

**5-8. `current_question` は保持期限（TTL）を必須にする（PII を放置しない）。**
保存先を `sessions/{id}` の単一フィールドにすると、セッション文書には TTL（`expireAt`）が無い（ADR-0014 保留）ため、
**未回答のまま離脱した質問**（`prompt`/`options` に個人情報を含みうる）が、発話・draft 要件の 30 日 TTL を**迂回して
残り続ける**。対応: 現在質問の保存先は **`expireAt` 付きサブコレクション**にする（発話/draft 要件と同じ 30 日 TTL を付与）。
`approved` のような保全対象ではないため、未回答のまま離脱したら他の一過性データと同じく TTL で消える（issue #10 の
データ最小化と整合）。

**5-9. クリアは「ハード削除」ではなく「TTL 付き tombstone」にする（`cleared_seq` を読めるよう残す）。**
回答時にドキュメントを**物理削除**すると、`GET /questions/current` が読む対象を失い、プロセス再起動後に返すべき
`cleared_seq` を復元できず、切断中に別参加者が回答したクライアントが古いピンを安全に畳めなくなる（§5-4 が成立しない）。
クリアは削除ではなく **tombstone 化**する: `question=null` + `cleared_seq` を残し、**PII を含む `prompt`/`options` は
削除/マスク**する（非 PII のクリア seq だけ残す）。tombstone 自体も §5-8 の TTL（30 日）で最終的に消える。
GET は tombstone を読んで `{question:null, seq=cleared_seq}` を返せる。
- **クリアも §5-1 と対称に「commit してから publish」**: 順序は **`cleared_seq` 予約 → tombstone commit →
  `question.cleared` publish**。tombstone commit 失敗時は publish しない。これを怠ると、回答直後に `question.cleared`
  だけ届いてからリロード/途中参加が起きたとき、LiveKit は clear を再送せず GET はまだ古い current question
  （`cleared_seq` 無し）を返し、回答済みのピンが復活する。
- **commit 後の publish 失敗を成功扱いしない**: 現行 `EventPublisher._emit` は `transport.send` 例外を握りつぶして
  envelope を返す（`events.py:134-139`）。これをそのまま使うと、Firestore は tombstone 済みなのに接続中の他参加者へ
  clear が届かず、次イベント/再接続が無い限り古いピンを出し続ける。**commit 後の publish 失敗を検知して retry**する
  （tombstone は冪等なので安全に再送できる）、または**送信失敗を呼び出し元へ返して補償**する。最終的な耐障害境界は
  tombstone（§5-9）＋ハイドレーション GET（§4）で、再接続・欠番検知（§4 gap）時に確実に復元できる点は変わらない
  （live clear はあくまで「接続中の即時反映」のベストエフォート）。

**5-10. クリア適用は ask と同じ seq 規律にする（GET null / live `question.cleared` 共通）。**
クリアの適用（GET の `question:null` 受信、または live `question.cleared` 受信）は、`question.asked` の適用
（§5-2）と**対称な seq ガード**で行う。無条件に畳むと順序逆転で新しい問いまで消える。
- **適用条件**: `cleared_seq > lastQuestionSeq`（古いクリアが新しい問いを畳まない）。live `question.cleared`
  は加えて **`event.question_id === current?.id`**（別の問いを対象にした遅延クリアで現在の問いを消さない）。
  例: `q2.ask(seq=7)` 適用後に遅延 `q1.cleared(seq=6)` が届いても、`6 > 7` 偽で棄却。
- **適用時の状態更新**: ピンを畳む（`question=null`）と同時に **`lastQuestionSeq = Math.max(lastQuestionSeq,
  cleared_seq)`** と **`maxSeq = Math.max(maxSeq, cleared_seq)`** の**両方**を進める。`lastQuestionSeq` を進めないと、
  別の遅い GET が `question seq < cleared_seq` で後着したとき §5-2 の `seq > lastQuestionSeq` を満たして
  クリア済みの問いを復活させる。`maxSeq` を進めないと次イベント `cleared_seq+1` を誤 gap 検知する（§5-4）。
- **棄却した live クリアでも `maxSeq` と `lastQuestionSeq` を進める**: id 不一致・`current=null`（ask を取り逃した）で
  ピンを畳まない場合でも、live `question.cleared` を受信した事実として **`maxSeq = Math.max(maxSeq, event.seq)`** と
  **`lastQuestionSeq = Math.max(lastQuestionSeq, event.seq)`** の**両方**を進める。`maxSeq` を怠ると受信済みの `event.seq`
  を欠番扱いし次の `event.seq+1` で誤 gap を発火する（`reduce()=false` で `maxSeq` 未更新／`store.ts:206-213`）。
  **`lastQuestionSeq` を怠ると**、`current=null` のまま `q1.cleared(seq=6)` を受けた直後、先に開始していた古い
  `GET /questions/current` が `q1(seq=5)` で後着したとき §5-2 の `seq > lastQuestionSeq`（=0）を満たして**クリア済みの
  q1 を復活**させる（§5-2 の「適用有無に関わらず seq カーソルを前進」をクリアにも対称適用）。

**5-11. question hydration の seq で他スナップショットの欠落を隠さない。**
`maxSeq` は**全イベント型共通の欠番カーソル**である。`question.asked` は session 境界（`last_seq`）を進めない（§3）一方、
global envelope seq は消費するため、`asked_seq` は requirements スナップショットが返す境界より**大きくなりうる**。
ここで `GET /questions/current` だけ成功し `/requirements`・`/detections` が失敗した場合（現行 hook は各 GET を個別に
catch して続行する）、§5-2/§5-4 の「question 由来 seq で global `maxSeq` を進める」を無条件に適用すると、切断中に
取り逃した requirement/detection 差分 `K+1..N-1` の gap を隠し、次の live `N+1` を正常連続に見せて再取得を抑止する。
- **規律**: question hydration は **`lastQuestionSeq`（question 専用ガード）は常に**進めてよいが、**global `maxSeq` は
  その画面で必要な主スナップショット GET が全て成功したときだけ**進める。`maxSeq` は全イベント型共通の欠番カーソル
  なので、`/requirements`（session 境界の出所）**だけでなく `/detections`** も含め、**いずれか一つでも失敗した
  hydration パスでは question 由来 seq で global `maxSeq` を進めず、gap/retry を残す**。例: `/requirements` 成功・
  `/detections` 失敗で `/questions/current` だけ `seq=N` を返しても、切断中の `detection.*` 差分 `K+1..N-1` を未復元の
  まま `maxSeq=N` に進めて次の live `N+1` を正常連続に見せてはならない。
- これは**ハイドレーション（GET）**に限った規律で、§5-2 後段・§5-4・§5-10 の「live イベント受信で `maxSeq` 前進」とは
  両立する（live は実際に global ストリーム上で受信した seq なので進めてよい）。

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
   現在質問の保存（**`expireAt` 付きサブコレクションの単一ポインタ**＝§5-8、`asked_seq` 付き）を
   `ask_question` に、クリアを回答時に追加。
   - **§5-1 / 5-1欠番**: publisher に seq 事前採番 or 送信前永続化フックを設け、**採番 → 保存 → 送信**の順を
     保証。採番は確定させず（`self._seq+1` を覗くだけ）、保存失敗時は送らず欠番を作らない。
   - **§5-3 / 5-7 / 5-9**: クリアは現在質問 id == `question_id` のときのみ。id 照合 + **tombstone 化**
     （`question=null` + `cleared_seq`、`prompt`/`options` は削除/マスク）+ `cleared_seq` 記録を
     **Firestore transaction / CAS** で原子的に行う（物理削除しない＝§5-9。`ask_question` の上書きとの競合回避）。
   - **§5-5 / 5-9 / cleared_seq 単一予約**: クリア時に **`question.cleared`（live イベント / `question_id` + `cleared_seq`）を
     publish**して全参加者へ伝播（契約 §2 に新規追加）。seq 境界は進めない。`cleared_seq` は `question.cleared` の
     **envelope seq そのもの**（二重採番しない）で、tombstone・live・GET の seq に同一値を使う。順序は **予約 →
     tombstone commit → publish**、commit 失敗時は publish しない（§5-1 と対称）。**commit 後の publish 失敗は
     成功扱いしない**（`_emit` の例外握り潰しに依存せず retry / 呼び出し元へ返す。最終耐障害は tombstone + GET）。
   - **§5-6**: options の有無に関わらず、未回答 current の間に届いた `user.text`/音声発話を当該 current への回答と
     みなしてクリアする経路を実装（`user.answered` のタップ id 一致は追加の早期クリア経路）。**発話受信時点の current
     id を束ねて §5-7 の CAS でクリア**する（遅い no-id 処理が後続 q2 を誤クリアしない）。
2. **API**（`apps/api/.../repository.py`・`main.py`）: `ReadRepository.get_current_question()` と
   `GET /api/sessions/{id}/questions/current`（`require_session_access` / レスポンス schema /
   `question_hydrated` ログ・メトリクス）を追加。`question: null` でも `seq=cleared_seq` を返す（§5-4）。
   **既存 3 API は変更しない**。
3. **Web**（`apps/web/lib/realtime/store.ts`・`useRealtimeSession.ts`）: `hydrateQuestion(question, seq)`
   （**`seq > lastQuestionSeq` のときだけ** `this.question`/`lastQuestionSeq` を更新＝§5-2、`maxSeq` 前進は
   **主スナップショット（`/requirements` + `/detections`）が全成功した時のみ**＝§5-11）。**クリア適用は §5-10 のガード**で
   統一: `null` 適用と `question.cleared` 受信は `cleared_seq > lastQuestionSeq`（live は加えて `question_id === current?.id`）
   のときだけ畳み、適用時に **`lastQuestionSeq` と `maxSeq` の両方を `cleared_seq` まで前進**。**畳まない live クリアでも
   `maxSeq` と `lastQuestionSeq` を前進**（§5-10。`current=null` 時の復活窓を塞ぐ）。接続時 GET の結線（他 GET と同じ順序）。
4. **テスト**: agent の保存/クリア単体（§5-3 id 不一致でクリアしない・§5-1 保存→送信順・§5-1 保存失敗で seq 欠番
   なし・§5-7 並行回答とトランザクション・§5-6 自由記述回答でクリア + no-id 経路の id 束ね・§5-9 クリアの commit→publish 順）、
   API GET 単体（Bearer 必須 / 未提示・回答済みで null + `seq`）、web store 単体（古いライブ/古い GET は破棄・新しい問いで
   置換・**復元直後の `N+1`/`N+2` で誤 gap を出さない**§5-2/5-4・遅延 null が新しい問いを消さない・**§5-10: 遅い GET 後着で
   クリア済みを復活させない・古い `question.cleared` で新しい問いを畳まない・畳まない clear でも maxSeq/lastQuestionSeq 前進**・
   **§5-11: `/requirements` か `/detections` が失敗した hydration では question seq で maxSeq を進めず gap/retry を残す**）。
5. **観測性**（CLAUDE.md 原則3 / 契約 §5）: `requirements_hydrated` と同様に件数・有無を計測。`question.cleared`
   publish にも span/log（§5-5）。
6. **TTL/プライバシー（§5-8）**: 現在質問サブコレクションに発話/draft 要件と同じ 30 日 TTL を付与（issue #10 整合）。

## 却下案

- **方式B（seq を進めない・再配信頼み）**: 途中参加を救えず、リロード復元が不定、契約 §4 の GET 復元
  体系から外れる。非推奨。
- **issue 素案の `POST /api/sessions/{id}/questions`**: API に書き込み往復を増やし、agent 直書きの
  既存パターン（要件/検知）から外れる。agent 直書き + GET 1 本の方が一貫する。
- **全質問履歴のサブコレクション化**: 監査用途では有用だが、UI は「最新1問」モデル。MVP は現在質問
  ポインタで十分。履歴保持は将来 issue 化。

## 保留（未解決リスク）

- 「最新1問」ポインタのため、複数の未回答質問を同時に並べる UI へは未対応（現行 UI 仕様どおり）。
- 現在質問ドキュメントの TTL は **§5-8 で必須化**（`expireAt` 付きサブコレクション、30 日 TTL）。セッション
  finalize 時にも合わせてクリアするかは実装時に決める（保全対象ではないため未回答離脱は TTL で消える）。
- `question.cleared`（§5-5）の追加は realtime 契約 §2 への新規イベント追加。既存イベント/3 API の仕様は
  変えないが、契約ドキュメントの更新が WAVE2 に含まれる。

> 本書は設計判断の記録（提案）。最終採否は人間レビューを経る（CLAUDE.md 原則1）。
