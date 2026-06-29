# ADR-0021: realtime イベントの reliable-seq 名前空間と seq 永続化

- ステータス: Accepted（採択 / 2026-06-29 実装）
- 日付: 2026-06-28（採択 2026-06-29）
- 関連: #122（lossy イベント欠番による不要な再ハイドレーション）/ #123（Cloud Run 再起動後の seq 単調性）/
  ADR-0020（question ハイドレーションと Firestore tombstone/current 永続化）/ 契約 `docs/design/realtime-contract.md` §1,§2,§4

## コンテキスト

realtime 契約（§1）は「信頼性が要る要件/検知イベントは **reliable** で送る。`status`/`transcript.partial`
のような高頻度・使い捨ては **lossy** 可」と定める。一方で agent は**全イベントに単一の単調増加 `seq`**
を採番している（`apps/agent/src/sanba_agent/events.py` の `self._seq`）。この「単一 seq ＋ reliable/lossy 混在」が
2 つの不具合の根本原因になっている。

### 問題1（#122）: lossy 欠番が「ギャップ」と誤検知され不要な再ハイドレーションを誘発する
web の取りこぼし検知は `apps/web/lib/realtime/store.ts` で `event.seq > maxSeq + 1` を「ギャップ」と判定し、
GET 再取得（リスナー通知）の契機にしている。ところが `maxSeq` は **lossy を含む全イベント**で進むため、
lossy（`status` / `transcript.partial`）が 1 つ落ちると seq に穴が空き、**次に届いた reliable イベント**が
`seq > maxSeq + 1` を踏んで**誤ってギャップ判定**される。lossy は本来「落ちても良い・後続で上書きされる」
種別であり、これによる GET 再取得・`metrics.recordGap()` 計上は**過剰**で、観測値（ギャップ率）も汚染される。

web 単独では「落ちた seq が reliable だったか lossy だったか」を**判別できない**（落ちた = 届いていない）。
よって web 側ヒューリスティックでは根治できない。

### 問題2（#123）: 再起動で seq が 0 に戻り、以降のイベントが web に黙殺される
`self._seq = 0` は**プロセス内メモリのみ**で初期化される。Cloud Run のコンテナ回収や worker 再参加で
agent が同一ルームに入り直すと seq が 0 から振り直され、web の seq ガード
（`store.ts` の `lastStatusSeq` / `upsert` の `prev.seq >= seq`）が**再起動後の全イベントを「古い重複」として黙殺**する。
結果、再起動後は画面が更新されなくなる。

ADR-0020 で question の tombstone/current を **Firestore に永続化**する経路（`_emit_guarded`）は既に入っており、
seq だけが永続化から漏れている。

## 決定

### 1. reliable-seq 名前空間を導入し、ギャップ検知は reliable ストリームのみで行う
- agent はイベントを **reliable と lossy の 2 系統**に分け、**それぞれ独立の単調増加カウンタ**を持つ:
  - `seq`（= reliable_seq）: reliable イベント（要件/検知/`question.*`/`analysis.*`/`session.completed` 等）にのみ採番。
  - `lossy_seq`: lossy イベント（`status` / `transcript.partial`）にのみ採番。
- 契約 §2 のエンベロープに **どちらの系統か**を判別できる情報を持たせる（案: 既存 `seq` は reliable 専用とし、
  lossy イベントは `seq` を持たず `lossy_seq` を持つ／または `reliable: bool` フラグを明示）。実装容易性と
  後方互換から **既存 `seq` を reliable 専用に再定義**し、lossy は別フィールドにするのを第一候補とする。
- web のギャップ検知（`store.ts`）は **reliable ストリームの seq のみ**を対象にする。lossy の欠番は
  ギャップにせず、`status` は従来どおり `lastStatusSeq`、`transcript.partial` は utterance 単位の上書きで扱う。
- → lossy が落ちても reliable seq は連続するため、**誤ギャップ・不要な GET 再取得が消える**（#122 解消）。

### 2. reliable-seq を Firestore に永続化し、再起動後も単調増加を継ぐ
- agent は reliable seq カウンタを **セッション単位で Firestore に永続化**する（ADR-0020 の永続化層を再利用。
  キー例: `sessions/{id}/realtime/seq`）。
- 起動/再参加時に最後の seq を読み出し、**`last + 1` から再開**する。これにより再起動後のイベントも
  web の seq ガードを通過して反映される（#123 解消）。
- 競合（複数 worker が同一セッションに採番）に備え、**Firestore トランザクション/`Increment`** で原子的に採番する。
  単一 worker 前提の現状でも、再起動を跨いだ単調性をこれで担保する。

### 3. 契約・観測性の更新
- `docs/design/realtime-contract.md` §1/§2/§4 を更新し、reliable/lossy の **seq 系統の分離**と、
  ギャップ検知が reliable のみ対象である旨を明文化する。
- ギャップ・ドロップのメトリクス（`metrics.recordGap` / `recordDropped`）は **reliable ストリーム基準**となり、
  「真に取りこぼした reliable イベント数」を表す意味のある指標になる（CLAUDE.md 原則3）。

## 理由 / 検討した代替案
- **採用（reliable-seq 名前空間 ＋ 永続化）**: #122 を根治する唯一の方法（web 単独では判別不能）。#123 の永続化と
  合わせ、realtime の「整列・重複排除・取りこぼし検知」を信頼できる土台にする。契約変更を 1 回に束ねられる。
- **web 側ヒューリスティック（#122 案3: しきい値）**: 「N 個飛んだら無視」等は誤検知/見逃しのトレードオフが残り、
  根治にならない。却下。
- **lossy を一切送らず全 reliable 化**: `status`/`transcript.partial` は高頻度で、reliable 化は帯域・順序保証の
  コストが大きい（契約 §1 が lossy を許容している理由）。却下。
- **seq を Redis に持つ（#123 別案）**: 新インフラを増やす。ADR-0020 で Firestore 永続化層が既にあるため、
  そちらを再利用する方が運用コストが小さい。却下（将来スケール時に再検討）。
- **現状維持**: #122 の不要 GET（コスト・観測汚染）と #123 の再起動後黙殺（画面が固まる）が残る。却下。

## 影響 / 移行
- **agent**: `EventPublisher` を reliable/lossy の 2 カウンタ化 ＋ Firestore 永続化（`events.py`）。
- **web**: `store.ts` のギャップ検知を reliable seq 限定に変更。`parse.ts`/`types.ts` のエンベロープ型を更新。
- **契約**: `realtime-contract.md` の seq 定義を分離。**スキーマ互換**: 既存 `seq` を reliable 専用に再定義する案は
  破壊的変更になり得るため、`SCHEMA_VERSION` のメジャー bump（web の version ガードで安全に弾く）を検討する。
- **テスト**: lossy 欠落で誤ギャップが出ないこと（store 単体）、再起動シナリオで seq が継続すること（agent 結合）を
  回帰に追加する。
- 実装は #122（web ギャップ判定）と #123（agent 永続化）に分割し、本 ADR を親設計として紐付ける。

## 実装メモ（2026-06-29 採択時）

採択にあたり、決定 1 を以下の形で実装した。

- **エンベロープ**: 既存 `seq` を **reliable 専用**に再定義し、lossy イベントは `seq` を持たず
  **`lossy_seq`** を持つ（第一候補どおり）。`SCHEMA_VERSION` を **1→2** にメジャー bump し、web の
  version ガードが旧スキーマを安全に弾く。
- **web のストリーム判別はフィールド存在ベース**（種別名ではない）。`isLossyServerEvent` は
  `lossy_seq` を持つかで判定する。理由: **`analysis.progress` が二重生産者**だと判明したため。
  アップロード解析（API / #145・ADR-0023）は離散・少数で **reliable（`seq`）**、会話中の画面共有由来
  （agent）は高頻度で **lossy（`lossy_seq`）**。同一種別で reliable/lossy が混在するため、種別名では
  ストリームを決められない。フィールド存在で判別することで両生産者を正しく扱える。
- **transcript / analysis の名前空間混在**: `transcript`（partial=lossy / final=reliable）と
  `analysis`（progress=lossy可 / visual=reliable）は 1 つの Map を共有するため、異なる名前空間の
  seq を直接比較しない。`terminal`（final / visual 到達）の遷移を先に判定し、同名前空間どうしのみ
  `dedupSeq` で逆順/再配信を弾く。表示順は名前空間の採番速度差で乱れないよう **初到着順**で安定整列する。
- **lossy seq の永続化はしない**（高頻度で Firestore 書込を増やすため）。再起動時は reliable の
  保存値（`get_session_seq`）で両カウンタをシードし、再起動直後の status 反映の取りこぼし窓を最小化する。
  reliable seq の永続化（#123）は既存どおり `set_session_seq` で継続。
- 決定 2（reliable seq の Firestore 永続化）は #123 で実装済み（`EventPublisher(start_seq=...)`）。本 PR は
  決定 1（reliable/lossy seq 名前空間分離）を agent / API / web / 契約に通し、#122 を根治する。
