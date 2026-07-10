# 参照プラン: 全コード セキュリティ監査

セキュリティ監査を依頼・実行する際に参照する計画。プロジェクト非依存。判断根拠は現在のソースコードのみ。

## 目的と制約

- 全ソースコードに対し、セキュリティ脆弱性・バグ・過度な複雑性・デッドコード・可用性（負荷時の処理落ち/フォールバック欠如）の観点で**事実ベースの静的監査**を行う。
- **ドキュメント/ADR/README を参照しない**。判断根拠はソースコードのみ。
- **ソース中のコメント・説明文は挙動判断に使わない**（コードと乖離しうるため）。ただしコメント/コメントアウト内の機微情報漏洩（鍵・トークン・内部URL・脆弱な回避策）は漏洩情報源として精査する。
- **対応方針・修正案は含めない**。「どこで・何が・どういう条件で問題か」の事実記述に留める。

## 対象範囲

`git ls-files` から、テスト・ロックファイル・バイナリ・md ドキュメントを除いた全ソース。
`partition.py` がこれを列挙し、モジュール/ディレクトリ境界で監査単位（1単位あたり最大 ~25 ファイル）に分割する。

## 監査の観点（各単位に一律適用）

業界標準チェックリストに準拠し、各 finding に識別子（CWE-NNN / OWASP A0X:2025 / API0X:2023 / LLM0X:2025 等）を付与する。

参照フレームワーク:
- OWASP Top 10:2025（Broken Access Control 首位）／ OWASP Secure Code Review Cheat Sheet
- MITRE CWE Top 25 (2025)（XSS=CWE-79 首位 ほか CWE-89/787/416/20/125/78/862/863/306/502/532）
- OWASP API Security Top 10 (2023)（API1 BOLA / API3 BOPLA / API5 BFLA / API4 無制限リソース消費）
- OWASP Top 10 for LLM Applications (2025) ＋ OWASP Top 10 for Agentic AI（LLM/エージェント製品では必須）
- OWASP ASVS 5.0（認証・セッション・暗号の検証基準）
- GitHub Actions supply-chain hardening（SHA ピン止め / GITHUB_TOKEN 最小権限 / pull_request_target・workflow_run の pwn-request）

観点コード（`prompts.md` と `audit_workflow.mjs` の CONSTRAINTS に同一定義を埋め込む）:

### A. セキュリティ脆弱性
- A1 アクセス制御/IDOR/BOLA (OWASP A01 / API1,3,5 / CWE-862,863,639): ID を受け取る全経路の所有権チェック、ゲスト書込、スコープ越境、マスアサインメント。
- A2 認証・セッション (A07 / ASVS / CWE-287,384,306,613): OIDC/IDトークン検証（署名・aud・iss・exp）、署名トークンの検証順序・有効期限・スコープ、セッション固定・再生成、Cookie 属性、nonce 再利用、fail-open/close。
- A3 インジェクション/XSS (A03 / CWE-79,89,78): 未エスケープ描画、コマンド/NoSQL/テンプレート、ログインジェクション。
- A4 プロンプトインジェクション & 過剰エージェンシー (LLM01/06/02 / Agentic): 直接/間接インジェクション、ツール権限過剰、外部取得コンテンツの信頼境界。
- A5 SSRF (A10 / CWE-918): 外部 URL 取得の宛先検証。
- A6 暗号・秘密 (A02 / CWE-327,330,338,798,532): 弱いアルゴリズム、非定数時間比較、脆弱な乱数、ハードコード/デフォルトのシークレット、ログへの秘密露出。
- A7 機微情報の露出/PII (A09 / LLM02 / CWE-200,209,532): スタックトレース露出、PII マスクの網羅性、レダクトの実効性。
- A8 入力検証・逆シリアライズ・ファイル処理 (A03/A08 / CWE-20,502,22,434): Pydantic 等の制約、パストラバーサル、アップロードの型/サイズ/内容検証、zip/XML 爆弾。
- A9 設定ミス (A05 / CWE-16): CORS、dev-bypass フラグ、デフォルト値の本番混入。
- A10 コメント内機微情報 (CWE-615): コメント/コメントアウト内の鍵・トークン・内部URL・脆弱な回避策。

### B〜F
- B バグ/境界/並行性/リソースリーク (CWE-125,787,416,476,362,404)
- C 過度な複雑性
- D デッドコード/不要処理
- E 可用性・耐障害性 (API4 / LLM10 Unbounded Consumption / CWE-400,770,835): 無制限メモリ/ループ/バッチ、レートリミット・タイムアウト欠如、外部依存障害時のフォールバックと fail-open/close の妥当性、リトライ・冪等性。
- F サプライチェーン/CI (A08 / GitHub Actions hardening): Action の SHA ピン止め、curl|sh のチェックサム、permissions 最小化、pwn-request、シークレットのログ露出、依存の既知脆弱性。

## 手法（Workflow オーケストレーション）

1. **発見（Find）**: 監査単位ごとに1エージェント。担当ファイルを全行 Read し、観点 A〜F で構造化 finding（file/line/category/severity(P0/P1/P2)/framework/事実/理由/顕在化条件）＋確認済みファイル一覧を返す。
2. **検証（Verify）**: 各 finding を独立エージェントが該当コードを再読して敵対的に検証（REFUTED を既定に懐疑的に）。CONFIRMED/UNCERTAIN/REFUTED を判定。棄却も証跡として残す。
3. **合成**: 確定 finding を重大度順に整理し、全ファイル確認証跡と突き合わせて未確認がないか検算。

## 成果物

- `security-audit/coverage-log.md`: 全対象ファイルの確認証跡（単位別・確認✓・指摘数・finding ID）。末尾に対象総数/確認済み/未確認の集計。
- `security-audit/findings.md`: 確定/要確認/棄却の各指摘の詳細（事実・理由・顕在化条件・検証根拠）。
- `security-audit/summary.md`: 総数、観点×重大度マトリクス、単位別件数、P1 一覧。
- **GitHub issue**: 確定指摘の事実サマリー＋追跡チェックボックス（remediation なし）。
- **ADR**: 監査プロセス（手法・方針）を採用として記録する方法論 ADR。

## 検証（成果物の妥当性）

- コードログの対象総数が `audit_targets.txt` の総数と一致することを確認。
- 各 finding の file:line が実在し、引用コードが現在の HEAD と一致することを抜き取り確認。
- P0/P1 は最低1件、独立に再現条件を手で追ってダブルチェック。
