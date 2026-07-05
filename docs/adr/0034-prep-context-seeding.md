# ADR-0034: セッション準備情報を agent の初期前提としてシードする

- ステータス: Accepted
- 日付: 2026-07-05

## コンテキスト
02 準備フォームで入力されたゴール・詳細（背景・現状・制約）は、join 後に
`POST /api/sessions/{id}/context`（source_name=goal / goal_detail）で Elasticsearch の
grounding にのみ投入されていた。この経路には2つの穴がある。

1. **agent が読む保証がない**: kind=context の chunk は `search_grounding` を agent が
   自発的に呼んだときにしか届かない。第一声の時点で agent は準備情報を知らず、
   「何を作りたいですか」というゼロからの聞き取りに戻ってしまう（ユーザー体験としては
   「準備で書いたことが何も引き継がれていない」）。
2. **タイミング競合**: context 投入は join 済みトークンが必要なため join 後になるが、
   agent の初期 instructions は LiveKit ルーム接続時（≒join と同時）に組み立てられる。
   索引が間に合う保証がない。

同型の問題は ADR-0028（repo 前提）で「索引済み要約を初期 instructions に proactive に
シードし、retrieval 任せにしない」という形で解決済み。また grill-me 化（ADR-0024）の
目的である「矛盾・曖昧さの解消」は、準備時の記入と会話中の回答の食い違い検出にも
そのまま適用できるはずだが、ADK の矛盾検知は準備情報を受け取っていなかった。

## 決定
準備フォームのゴール・詳細を **セッション作成時に `SessionMeta` へ保存**し、agent が
起動時に読んで前提としてシードする。

1. **web → API**: `POST /api/sessions` に `goal` / `goal_detail` を追加（上限 2000 / 8000 字）。
   作成はページの join より前なので、agent 起動時には必ず読める（競合の解消）。
   既存の join 後 RAG 投入（source_name=goal / goal_detail）は併存させる:
   初期前提はシードが、会話後半の想起は `search_grounding` が担う（ADR-0028 と同じ分担）。
2. **agent 初期 instructions**: developer モードで `build_prep_premise()` を
   `VOICE_AGENT_INSTRUCTIONS` の直後・repo 前提の前に挿入する（主題が先、裏付けが後）。
   準備情報がある場合の開始指示は「ゴールを一言で要約して認識合わせ→一歩深掘り」に
   切り替え、ゼロからの聞き取りを禁じる。記入内容は repo 要約・glossary と同様に
   `<prep-context>` で区切り非信頼データとして扱う（prompt injection 対策）。
3. **ADK 分析への注入**: `analyze_requirements` に渡す transcript の先頭へ
   「準備フォームの記入内容（発話ではない）」ノートを前置し、統括・矛盾検知が
   準備時の記入と会話中の回答の食い違いも検出できるようにする。
4. **end_user モードにはシードしない**: 準備フォームは owner の開発向け記入であり、
   利用者インタビュー（ADR-0032）に持ち込むと語彙の遮断（決定6）を破るため。

## 根拠
- 「retrieval 任せにしない」は ADR-0028 で実証済みのパターン。準備情報はセッションの
  主題そのものであり、repo 要約以上に proactive シードの価値が高い。
- SessionMeta 経由は追加の LLM 呼び出しゼロ・Firestore 読み取りも既存の 1 回に相乗り
  （`build_agent_instructions` がモード判定で読む同じ文書）でレイテンシ影響がない。
- 矛盾検知への注入は grill-me 化（ADR-0024）の「矛盾・曖昧な言葉を掘る」を準備情報まで
  拡張するもので、トポロジ（ADR-0002）は変えない。

## 影響
- `SessionMeta` に `goal` / `goal_detail` を追加（旧文書は None フォールバックで互換）。
- プロンプト退行ガードを `apps/agent/tests/test_prompts.py` に追加。モード分岐と
  シード順は `apps/agent/tests/test_interview_mode.py` で検証する。
- 本番プロンプトは引き続き Langfuse Prompts と同期する（`interview.py` 冒頭の方針）。
