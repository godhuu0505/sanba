# ラベル運用ガイド

SANBA の issue / PR ラベルは **軸（dimension）ベース**で設計し、**IaC（`.github/labels.yml`）**で管理する。
手動で `gh label edit` せず、必ず manifest を編集して PR で変更する。

## 単一の真実 = `.github/labels.yml`
- main に push されると `.github/workflows/labels.yml`（`crazy-max/ghaction-github-labeler`）が同期する。
- **manifest に無いラベルは削除**される（`skip-delete: false`）。新しいラベルが要るときは manifest に足す。
- 改名は manifest の `from-name:` で行う。**既存 issue/PR の付与を保持したまま**改名される。
- 手動で UI/CLI からラベルをいじると drift する。次回同期で manifest に巻き戻る。

## 軸（接頭辞）
1 つの issue/PR に、各軸から **0〜1 個**を付ける。

| 軸 | 接頭辞 | 例 | 付け方 |
|----|--------|----|--------|
| 種別 | `type:` | `type:bug` `type:feature` `type:docs` `type:refactor` `type:security` `type:infra` `type:test` `type:chore` `type:ci` | 人間 |
| 優先度 | `priority:` | `priority:p0`（最優先）→ `priority:p3`（低） | 人間 |
| 対象 | `area:` | `area:agent` `area:api` `area:web` `area:infra` `area:docs` | **PR は自動**（path）/ issue は人間 |
| 状態 | `status:` | `status:ready` `status:in-progress` `status:blocked` | 人間 |
| 自動化 | `ai:` | `ai:build` `ai:babysitting` | ADR-0015 参照 |

### 接頭辞を付けない例外
- `needs-human` … ADR-0015 §6 の**エスカレーション・コントラクト名**。自動化が文字列一致で参照するため、
  axis prefix を付けず**この正確な綴りを維持**する（rename 禁止）。状態軸の一員として運用する。
- `ai:build` / `ai:babysitting` … ADR-0015 §1,§3 で固定。同じく rename 禁止。
- メタ: `epic` `discussion` `hackathon`、dependabot 管理: `dependencies` `github_actions` `docker` `python` `javascript`。

## 自動付与
- **`area:*`（PR）**: `.github/labeler.yml` のパスルールで `actions/labeler` が付与する（`apps/web/**` → `area:web` など）。
  同一リポジトリのブランチ PR が対象。fork PR は対象外（ADR-0015 §10「当面 fork を受け付けない」）。
- **dependabot**: `dependencies` 等を自動付与（manifest 側で保持）。

## 色の規約（1 軸 1 色相を基本）
- `priority:` 温度グラデ（p0 赤 → p2 黄 → p3 淡黄）
- `area:` 青系
- `status:` 緑（ready）/ 黄（in-progress）/ 灰（blocked）。`needs-human` のみアラート赤。
- `type:` は語で読むため色は補助。

## 運用フロー
1. issue を立てると、テンプレが `type:bug` / `type:feature` を初期付与。起票者が `priority:` `area:` を足す。
2. 着手可なら `status:ready`、前提待ちなら `status:blocked`。
3. （将来）`ai:build` を付けると Claude が実装〜PR〜babysitter（ADR-0015）。自走停止時は `needs-human`。
4. PR を出すと `area:*` が自動で付く。
