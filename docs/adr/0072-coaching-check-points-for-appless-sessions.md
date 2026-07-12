# ADR-0072: 対象アプリ未指定セッションにコーチング型の既定確認観点を載せる

- ステータス: Accepted
- 日付: 2026-07-13
- 関連: [ADR-0071](0071-optional-target-app-for-session-start.md)（対象アプリ選択の任意化 — 本 ADR は
  その agent 側の欠落を埋める）/ [ADR-0057](0057-dynamic-check-point-coverage.md)（確認観点カバレッジ）/
  [ADR-0043](0043-audience-tagged-check-items-and-render-unification.md)（audience タグ付き確認項目）/
  [ADR-0055](0055-end-user-detection-handling.md)（end_user 検出と扱い）/
  [ADR-0031](0031-product-entity-and-invite-links.md)（product エンティティ・文脈シード）
- きっかけ: 本番セッション sess-b6a5524e（アプリ未指定・`product_id=null`）で、確認事項が 1 件も
  生成されないことをオーナーが発見（`check_items_count=0` / 全ターン `open_topics=0` /
  `resolved_inquiries=0`）。

## コンテキスト

ADR-0071 は対象アプリの選択を任意化し、「API・agent・DB への変更はない（`product_id` は既に任意）」
と結論した。この前提が agent 側の 1 経路を見落としていた。

`build_agent_instructions`（`apps/agent/src/sanba_agent/main.py`）は、このセッションで掘る確認観点
（`seeded_check_items`）を組み立てるとき `product is not None` のときだけ `check_points_for_scope`
を呼び、product 不在なら `[]` を返していた。これは product 前提だった旧 1:1 セッション向けの
フェイルクローズ（`models.py` の docstring 明記）だったが、アプリ未指定を主要導線に昇格させた
ことで常時露出した。

確認観点が空になると下流が連鎖的に無効化される。

1. 初期プロンプトの確認観点シード（`build_check_items_seed`）が空 → LLM に掘る観点が渡らない。
2. 観点カバレッジ判定（`assess_check_point_coverage`）が `if check_points` で丸ごとスキップ →
   `coverage_open=[]`。
3. 確認事項ツリーへの CHECK ノード upsert（`inquiry_feeder`）が 0 件 → 確認事項パネルが空のまま。

深掘り（GAP/AMBIGUOUS）は product 非依存で背景分析が常時走るが、確認観点も準備前提も無い薄い
文脈（sess-b6a5524e の goal は「もやもやする」のみ）では ADK が open_topics を立てられず、
体感として「確認事項も深掘りも出ない」空振りになっていた。

## 決定

1. **確認観点シードのフェイルクローズを「product 不在」から「セッション文書不読」へ移す。**
   セッション文書を読めた（`meta is not None`）なら mode は信頼でき、product の有無に関わらず
   観点をシードする。文書不読のときだけ空に縮退する（mode が既定 developer に落ちて信頼できない
   ため、既存のフェイルクローズを維持）。
2. **対象アプリ未指定の developer/PdM セッションにコーチング型の既定観点を載せる。**
   `NO_PRODUCT_CHECK_POINTS`（新設）を選択の入口 `default_check_points(product, scope)` で返す。
   狙いは、まだ作るものが決まっていない相手から「本当に叶えたいこと・解消したい困りごと」を
   問いで引き出し、ゴールを一言で言える状態にすること（grill-me / 産婆術の思想を対象アプリの
   有無に関わらず深掘りへ通す）。観点は難しい言葉を避けた話し言葉にする:
   - 本当はどうなったら嬉しいか（叶えたい理想の姿）
   - いま何に困っているか、なぜ困るのか（困りごとの根っこ）
   - なぜ今それをやりたいのか（きっかけ・背景）
   - それが叶うと、誰の何がどう変わるか
   - どんな場面で、いつ必要になるか
   - いま、それをじゃましているものは何か
3. **end_user は product 不在なら素のまま（空）。** end_user は特定アプリの利用体験への
   フィードバックが前提で、対象アプリが無ければ掘る対象が無い。コーチング型観点は
   developer/PdM の発想段階向けなので end_user へは載せない。
4. **コーチング型観点は提供者由来ではなく系側の信頼できる既定として提示する。**
   `build_check_items_seed(owner_provided=False)` で、アプリ提供者への帰属も非信頼フェンスも付けず、
   見出しを「このセッションで掘り下げる観点」にし、ゴールを定めるための問いの起点として使わせる。
   product 由来の観点（owner 入力の非信頼データ）は従来どおり `owner_provided=True` でフェンスに囲む。

## 検討したが採用しなかった選択肢

- **`DEFAULT_CHECK_POINTS` にキーを足して一元化する**: この辞書は `dict[InviteScope, list[str]]`＝
  モードで引く前提。product 不在はモードと直交する軸なので、非モードの鍵を混ぜると型と意味が崩れる。
  リスト定数 1 個＋選択入口 1 関数（`default_check_points`）に集約する方が、辞書のモード別デフォルトを
  汚さず責務も分かれる。却下。
- **コーチング型観点を owner_provided のまま既存シード文で流す**: 実装は最小だが、対象アプリが
  無いのに「アプリ提供者が登録した確認項目」と読み上げさせることになり、存在しない提供者に
  言及する事故を招く。系側デフォルトは提供者へ帰属させない。却下。
- **深掘り（GAP）にも product 不在用の固定前提を注入する**: open_topics の枯れは LLM 挙動で
  あってコードゲートではない。確認観点のシード復活で文脈が厚くなるため、まず観点シードで様子を
  見る。別途の前提注入は過剰。見送り。

## 影響

- packages/sanba_shared `models.py`: `NO_PRODUCT_CHECK_POINTS` と `default_check_points` を新設。
  `check_points_for_scope` の docstring から「product があるときにだけ使う」前提を外す。
- apps/agent `main.py`: `seeded_check_items` を `default_check_points(product, mode) if meta is not None`
  に、`build_check_items_seed` に `owner_provided=product is not None` を渡す。
- apps/agent `prompts/interview.py`: `build_check_items_seed` に `owner_provided` を追加。False では
  提供者帰属・非信頼フェンス無しの「掘り下げる観点」文面を組む。
- 観測性: アプリ未指定セッションでも `agent_instructions_built` の `check_items_count` が立ち、
  カバレッジ判定・CHECK ノード生成・確認事項 KPI（ADR-0057 / ADR-0061）が機能する。
- テスト: apps/agent `test_interview_mode.py`（アプリ未指定はコーチング観点をシード /
  end_user は素のまま / 提供者帰属文言を出さない）、packages/sanba_shared `test_output_formats.py`
  （`default_check_points` の 3 分岐）を追加・改訂。ADR-0071 で「素のまま」を保証していた旧テストを
  本 ADR の挙動へ改める。
