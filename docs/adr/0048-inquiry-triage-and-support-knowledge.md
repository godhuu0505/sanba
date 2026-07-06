# ADR-0048: 問い合わせトリアージとサポート知識（利用者の声の切り分け・その場解決）

- ステータス: **Accepted（受理）**
- 日付: 2026-07-06（提案・受理）
- 関連: [ADR-0032](0032-guest-join-and-enduser-mode.md)（利用者モード — 本 ADR は決定8 の
  allowlist を限定改訂する）/ [ADR-0002](0002-multi-agent-topology.md)（トポロジ — 変更しない）/
  [ADR-0037](0037-background-prefetch-and-injection-policy.md)（注入ポリシー — 案内経路の制約元）/
  [ADR-0014](0014-admin-and-login-screens.md)（承認と TTL）/ [ADR-0005](0005-llm-judge-eval-loop.md)（評価）
- 背景文書: [inquiry-triage.md](../design/inquiry-triage.md)（課題定義・会話設計・実装計画の詳細。
  本 ADR と食い違う場合は本 ADR を正とする）

## コンテキスト

利用者セッション（end_user モード / ADR-0032）に届く声はすべて「要望」の顔をしているが、
実際には要望・不具合・仕様・既実現・仕様への不満のいずれでもありうる。現行はすべて要望として
要件化するため、開発者は「すでにあるもの」の Issue を受け取り、利用者は解決できたはずの
困りごとを抱えたまま終える。切り分け（トリアージ）とその場解決を導入するが、
誤った案内は誤った要件化より深刻（利用者の信頼と声の両方を失う）であり、
repo 由来 grounding の出力遮断（ADR-0032 決定8 の fail-closed）とも両立させる必要がある。

## 決定

1. **inquiry の新設**: 問い合わせの結末は `sessions/{id}/inquiries/{inquiryId}` に記録する
   （`Requirement` の拡張は採らない）。分類は `feature_request / bug / by_design /
   already_supported / discoverability`、outcome は `requirement / bug_report / resolved /
   guided_unverified / recorded`。`symptom` / `situation` は **mask_pii を通し 30 日 TTL**。
   30 日を超えて意味を持つ頻度集約は**匿名化カウンタ（product × 分類 × 週）**を別文書に持つ。
   案内を伴う outcome には、案内時点の手順の**スナップショット**（premise / steps の凍結コピー）を
   `resolution_snapshot` として保存する（entry の後日編集・削除に影響されない再掲・監査のため）。
2. **サポート知識 `kind="support"` と出力 allowlist の限定改訂**:
   owner / admin が登録する利用者向けサポート知識（`products/{id}/support_entries`）のみを
   案内の根拠にできる。ADR-0032 決定8 の allowlist は `_USER_DERIVED_KINDS`（利用者由来）の
   意味を変えず、出力判定用の `_END_USER_OUTPUT_KINDS = _USER_DERIVED_KINDS | {"support"}` を
   別に新設して改訂する。不変条件:
   (a) **product_id スコープ必須（全モード）** — ES に `product_id`(keyword) を追加し、
   support は セッションの product 一致のみ返す。product 未解決時は 0 件（fail-closed）。
   (b) **モード未確認時は support を返さない**（返却条件は「モード確認済み end_user かつ
   product_id 確定」の AND）。
   (c) **フィルタは検索層**（プリフェッチキャッシュ書き込み前）に置く（ADR-0037 決定2 の維持）。
   (d) エントリ本文は非信頼データとして fence で囲む（glossary / repo 要約と同じ流儀）。
   (e) 更新・削除・非承認化は ES の該当 passage を削除し（決定的 `_id` の upsert ＋
   source prefix の delete_by_query）、さらに**返却時に entry の承認状態を再検証**して
   approved 以外は破棄する（repo 由来の stale 再検証と同じパターン。キャッシュ遅延で
   取り下げ済みの案内が返る穴を塞ぐ）。
   repo 由来 grounding の遮断（ADR-0032 決定8 の本体）は改訂しない。
3. **トリアージの実行形態**: ADK チームへの sub-agent 追加は採らず（現行チームは自由文出力で
   構造化された仮説・確信度を返せない）、`analyze_transcript` 内の**構造化単発呼び出し**
   （オンライン評価 `_llm_judge` と同型の JSON 出力）とする。**end_user モードのみ**実行し、
   Stage A では `analyze_requirements` のツール返却から `triage` を exclude して
   「発話を変えない」を構造的に保証する。トポロジ（ADR-0002）は不変。
4. **誤案内ガード（fail-to-record）**: 案内はサポート知識のターン内同期ヒット＋状況一致確認
   （`screen_terms` の復唱）を満たすときだけ行う。背景トリアージの仮説は次の一問と分類にのみ
   使い、案内のトリガーにしない（ADR-0037 決定1 の帰結）。推測に聞こえる表現
   （「〜かもしれません」等）は全面禁止。**1 つの inquiry への案内は最大 1 回**。
   `resolved` は利用者の自発的な解消の明言＋復唱確認のみで成立。
   `record_inquiry_outcome` ツールは、**案内を伴う outcome（`resolved` / `guided_unverified`）
   すべて**に対し `resolution_ref` が直前の search_grounding の support ヒットに含まれることを
   実装側で検証し、満たさなければ拒否する（KB に無い案内の記録・再掲を機械的に遮断）。
5. **適用範囲**: end_user モードのみ。developer モードは従来どおり。
6. **不具合の出口**: 自動 Issue 起票はしない。再現手順つき inquiry として記録し、owner が
   確認して Issue 化を判断する。export の更新対象は **API 側**
   （`apps/api/src/sanba_api/github_export.py` と `POST /api/sessions/{id}/export`）。
7. **利用者への返却**: セッション終端の結果確認（FR-3.1）に解決事例と未検証手順
   （スナップショットからのテキスト再掲）を表示し、利用者の訂正を教師信号として回収する。
8. **Stage C（解決事例の昇格）**: 出所メタの表示・owner による文言確定（原文コピー不可・要編集）・
   再 mask_pii ＋ fence 正規化・統計的昇格条件（検証成功 N 件・失敗 0 件）を必須とする。
   承認 UI は要件承認（ADR-0014）と同じ「AI 下書き・人間承認」の型。

## 却下した代替案

- **生の repo grounding で案内**: 漏洩（ADR-0032 決定8）と幻覚の二重リスク。
- **冒頭で分類を聞く IVR 型**: 利用者は分類できない。分類は会話の出力であって入力ではない。
- **Requirement 拡張で outcome を持つ**: `requirement.upserted` の固定契約・
  `RequirementStatus` に結線された TTL・`EDITABLE_REQUIREMENT_FIELDS` の閉集合と衝突し、
  解決事例が要件一覧・MoSCoW ボードに混ざる。
- **ADK sub-agent としてトリアージを追加**: lead の自由文から構造化出力を取り出せない。
- **不具合の自動 Issue 起票**: 誤分類ノイズと、ゲスト token の export 禁止
  （ADR-0032 決定4）との整合が崩れる。
- **realtime の `detection.*` に新 kind**: 未解消検知の集計は kind 非依存のため確定ゲートの
  件数を汚染する。必要時は独立イベント `inquiry.updated` を新設する。

## 影響 / フォローアップ

- `sanba_shared`: `Inquiry` / `SupportEntry` モデルと repository API。infra に TTL ポリシー。
- `apps/agent`: `heuristic_symptom_topics`（日本語限定・end_user のみ・非 ja では沈黙を
  構造化ログで可視化）、`triage_transcript`、allowlist 改訂、product_id の配管、
  end_user プロンプトへの案内会話原則（1 ステップずつ・画面共有打診・復唱確認・失敗時発話）。
- `apps/api`: support_entries CRUD（owner / admin）＋ ES write-through、
  `GET /api/sessions/{id}/inquiries`、export の bug セクション整形。
- 評価: `TRIAGE_SCENARIOS`（分類ミスリード例＋禁止ケース）を llm-eval に追加。
  前提として `_on_close` のオンライン採点をモード分岐させる（既存ギャップ）。
- 指標: resolved-in-session 率は単独 KPI にせず、案内実施率・セッションあたり新規要件数・
  誤案内率（entry 単位の検証失敗率＝陳腐化検知を兼ねる）と対で見る（CLAUDE.md 原則4）。
- 段階導入・PR 分割は [inquiry-triage.md §7](../design/inquiry-triage.md) を参照
  （Stage A は案内なし＝誤案内ゼロから始める）。
