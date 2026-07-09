# SANBA セキュリティ監査 — コードログ（全ファイル確認証跡）

- 監査対象: `origin/main` HEAD `f5d2065`
- 監査対象ファイル総数: **247**（テスト・ロックファイル・バイナリ・md ドキュメントを除く全ソース）
- 各ファイルは担当監査エージェントが Read ツールで全行読了。✓=確認済み。指摘数はそのファイルに紐づく確定 finding 件数。

## api-auth — 3 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/auth.py` | ✓ | 1 | SEC-021 |
| `apps/api/src/sanba_api/auth_google.py` | ✓ | 2 | SEC-007, SEC-022 |
| `apps/api/src/sanba_api/deps.py` | ✓ | 2 | SEC-023, SEC-024 |

## api-routers-session — 3 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/routers/auth.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/routers/session.py` | ✓ | 1 | SEC-012 |
| `apps/api/src/sanba_api/routers/sessions.py` | ✓ | 4 | SEC-039, SEC-040, SEC-041, SEC-042 |

## api-routers-products-members — 3 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/routers/github_link.py` | ✓ | 4 | SEC-034, SEC-035, SEC-036, SEC-037 |
| `apps/api/src/sanba_api/routers/members.py` | ✓ | 1 | SEC-038 |
| `apps/api/src/sanba_api/routers/products.py` | ✓ | 0 | - |

## api-routers-rest — 1 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/routers/__init__.py` | ✓ | 0 | - |

## api-integrations-github — 3 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/github_app.py` | ✓ | 3 | SEC-028, SEC-029, SEC-030 |
| `apps/api/src/sanba_api/github_export.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/repo_indexing.py` | ✓ | 1 | SEC-010 |

## api-integrations-io — 6 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/src/sanba_api/ingestion.py` | ✓ | 1 | SEC-011 |
| `apps/api/src/sanba_api/mailer.py` | ✓ | 1 | SEC-031 |
| `apps/api/src/sanba_api/storage.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/tasks.py` | ✓ | 1 | SEC-032 |
| `apps/api/src/sanba_api/titles.py` | ✓ | 1 | SEC-033 |
| `apps/api/src/sanba_api/vision.py` | ✓ | 0 | - |

## api-core — 10 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/api/Dockerfile` | ✓ | 0 | - |
| `apps/api/pyproject.toml` | ✓ | 0 | - |
| `apps/api/src/sanba_api/__init__.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/config.py` | ✓ | 2 | SEC-008, SEC-009 |
| `apps/api/src/sanba_api/main.py` | ✓ | 2 | SEC-025, SEC-026 |
| `apps/api/src/sanba_api/observability.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/pii.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/realtime.py` | ✓ | 0 | - |
| `apps/api/src/sanba_api/repository.py` | ✓ | 1 | SEC-027 |
| `apps/api/src/sanba_api/session_store.py` | ✓ | 0 | - |

## agent-core — 5 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/agent/src/sanba_agent/agent_team.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/background.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/events.py` | ✓ | 1 | SEC-001 |
| `apps/agent/src/sanba_agent/inquiry_feeder.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/main.py` | ✓ | 4 | SEC-002, SEC-003, SEC-004, SEC-017 |

## agent-tools-connectors — 15 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/agent/Dockerfile` | ✓ | 0 | - |
| `apps/agent/pyproject.toml` | ✓ | 1 | SEC-018 |
| `apps/agent/src/sanba_agent/__init__.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/config.py` | ✓ | 1 | SEC-005 |
| `apps/agent/src/sanba_agent/connectors/__init__.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/connectors/github.py` | ✓ | 2 | SEC-006, SEC-019 |
| `apps/agent/src/sanba_agent/evaluation.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/observability.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/pii.py` | ✓ | 1 | SEC-020 |
| `apps/agent/src/sanba_agent/prefetch.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/prompts/__init__.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/prompts/interview.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/retrieval.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/tools/__init__.py` | ✓ | 0 | - |
| `apps/agent/src/sanba_agent/tools/analysis.py` | ✓ | 0 | - |

## worker — 8 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/worker/Dockerfile` | ✓ | 0 | - |
| `apps/worker/pyproject.toml` | ✓ | 0 | - |
| `apps/worker/src/sanba_worker/__init__.py` | ✓ | 0 | - |
| `apps/worker/src/sanba_worker/analysis.py` | ✓ | 1 | SEC-078 |
| `apps/worker/src/sanba_worker/config.py` | ✓ | 1 | SEC-079 |
| `apps/worker/src/sanba_worker/main.py` | ✓ | 3 | SEC-080, SEC-081, SEC-082 |
| `apps/worker/src/sanba_worker/observability.py` | ✓ | 1 | SEC-083 |
| `apps/worker/src/sanba_worker/storage.py` | ✓ | 1 | SEC-084 |

## shared — 12 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `packages/sanba_shared/pyproject.toml` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/__init__.py` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/grounding.py` | ✓ | 2 | SEC-061, SEC-062 |
| `packages/sanba_shared/src/sanba_shared/inquiry.py` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/media.py` | ✓ | 1 | SEC-063 |
| `packages/sanba_shared/src/sanba_shared/models.py` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/output_formats.py` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/pii.py` | ✓ | 1 | SEC-064 |
| `packages/sanba_shared/src/sanba_shared/py.typed` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/realtime.py` | ✓ | 0 | - |
| `packages/sanba_shared/src/sanba_shared/repository.py` | ✓ | 1 | SEC-016 |
| `packages/sanba_shared/src/sanba_shared/result_document.py` | ✓ | 1 | SEC-065 |

## web-lib — 21 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/lib/api.ts` | ✓ | 1 | SEC-075 |
| `apps/web/lib/audience.ts` | ✓ | 0 | - |
| `apps/web/lib/auth.tsx` | ✓ | 0 | - |
| `apps/web/lib/choiceDisclosure.ts` | ✓ | 0 | - |
| `apps/web/lib/googleDrive.ts` | ✓ | 0 | - |
| `apps/web/lib/help/index.ts` | ✓ | 0 | - |
| `apps/web/lib/interviewMode.tsx` | ✓ | 0 | - |
| `apps/web/lib/issueExport.ts` | ✓ | 0 | - |
| `apps/web/lib/prepFormStorage.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/fixtures.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/index.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/mapping.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/metrics.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/parse.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/selectors.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/store.ts` | ✓ | 1 | SEC-076 |
| `apps/web/lib/realtime/types.ts` | ✓ | 0 | - |
| `apps/web/lib/realtime/useRealtimeSession.ts` | ✓ | 1 | SEC-077 |
| `apps/web/lib/slug.ts` | ✓ | 0 | - |
| `apps/web/lib/useChoiceDisclosure.ts` | ✓ | 0 | - |
| `apps/web/lib/utils.ts` | ✓ | 0 | - |

## web-app — 19 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/app/[slug]/prepare/page.tsx` | ✓ | 0 | - |
| `apps/web/app/[slug]/sessions/[id]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/design/page.tsx` | ✓ | 0 | - |
| `apps/web/app/error.tsx` | ✓ | 1 | SEC-066 |
| `apps/web/app/join/[token]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/layout.tsx` | ✓ | 0 | - |
| `apps/web/app/login/page.tsx` | ✓ | 0 | - |
| `apps/web/app/member-invites/[token]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/not-found.tsx` | ✓ | 0 | - |
| `apps/web/app/page.tsx` | ✓ | 0 | - |
| `apps/web/app/prepare/page.tsx` | ✓ | 0 | - |
| `apps/web/app/products/[id]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/products/page.tsx` | ✓ | 0 | - |
| `apps/web/app/results/[id]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/results/page.tsx` | ✓ | 1 | SEC-067 |
| `apps/web/app/sessions/[id]/page.tsx` | ✓ | 0 | - |
| `apps/web/app/settings/page.tsx` | ✓ | 0 | - |
| `apps/web/middleware.ts` | ✓ | 1 | SEC-068 |
| `apps/web/next.config.mjs` | ✓ | 1 | SEC-069 |

## web-components-1 — 25 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/components/AccessErrorScreen.tsx` | ✓ | 0 | - |
| `apps/web/components/AccountMenu.tsx` | ✓ | 1 | SEC-070 |
| `apps/web/components/AppShell.tsx` | ✓ | 0 | - |
| `apps/web/components/BottomBar.tsx` | ✓ | 0 | - |
| `apps/web/components/ChatHistory.tsx` | ✓ | 0 | - |
| `apps/web/components/ChoiceCompareSheet.tsx` | ✓ | 0 | - |
| `apps/web/components/ChoiceDetailSheet.tsx` | ✓ | 0 | - |
| `apps/web/components/ChoicePin.tsx` | ✓ | 0 | - |
| `apps/web/components/ChoiceStrip.tsx` | ✓ | 0 | - |
| `apps/web/components/ConversationSessionView.tsx` | ✓ | 0 | - |
| `apps/web/components/ConversationShell.tsx` | ✓ | 0 | - |
| `apps/web/components/ConversationStart.tsx` | ✓ | 0 | - |
| `apps/web/components/EndConfirmDialog.tsx` | ✓ | 0 | - |
| `apps/web/components/EndProposalCard.tsx` | ✓ | 0 | - |
| `apps/web/components/EntryFlow.tsx` | ✓ | 0 | - |
| `apps/web/components/ForceEndConfirmDialog.tsx` | ✓ | 0 | - |
| `apps/web/components/GitHubLinkCard.tsx` | ✓ | 0 | - |
| `apps/web/components/InquiryTree.tsx` | ✓ | 0 | - |
| `apps/web/components/JudgmentGate.tsx` | ✓ | 0 | - |
| `apps/web/components/MaterialCancelDialog.tsx` | ✓ | 0 | - |
| `apps/web/components/MaterialDetailSheet.tsx` | ✓ | 0 | - |
| `apps/web/components/MaterialSourceSheet.tsx` | ✓ | 0 | - |
| `apps/web/components/MaterialsList.tsx` | ✓ | 0 | - |
| `apps/web/components/MemberInviteNotices.tsx` | ✓ | 0 | - |
| `apps/web/components/ProductCheckItemsCard.tsx` | ✓ | 0 | - |

## web-components-2 — 25 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/components/ProductInvitesCard.tsx` | ✓ | 0 | - |
| `apps/web/components/ProductMembersCard.tsx` | ✓ | 0 | - |
| `apps/web/components/ProductOutputFormatsCard.tsx` | ✓ | 0 | - |
| `apps/web/components/ProductRepoCard.tsx` | ✓ | 0 | - |
| `apps/web/components/RequireAuth.tsx` | ✓ | 1 | SEC-071 |
| `apps/web/components/RequirementsScrollList.tsx` | ✓ | 0 | - |
| `apps/web/components/RequirementsTab.tsx` | ✓ | 0 | - |
| `apps/web/components/ResultView.tsx` | ✓ | 0 | - |
| `apps/web/components/SessionView.tsx` | ✓ | 0 | - |
| `apps/web/components/SideMenu.tsx` | ✓ | 0 | - |
| `apps/web/components/SidebarAccount.tsx` | ✓ | 1 | SEC-072 |
| `apps/web/components/VoiceStatusIndicator.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/AppHeader.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Avatar.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/BottomSheet.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/BrandMark.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/BrandSplash.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Button.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Card.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/ChatBubble.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Chip.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Divider.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Field.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Figure.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/HelpIcon.tsx` | ✓ | 0 | - |

## web-components-3 — 23 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/components/sanba/InsightCard.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/ListRow.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Logo.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Marquee.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Parade.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/RecPill.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/RequirementCard.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Screen.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/SessionHistoryList.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/SessionRow.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/StatTile.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/StatusBar.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/VoiceInputBar.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/Waveform.tsx` | ✓ | 0 | - |
| `apps/web/components/sanba/index.ts` | ✓ | 0 | - |
| `apps/web/components/ui/badge.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/button.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/card.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/input.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/label.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/select.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/table.tsx` | ✓ | 0 | - |
| `apps/web/components/ui/textarea.tsx` | ✓ | 0 | - |

## web-config — 10 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `apps/web/.dockerignore` | ✓ | 0 | - |
| `apps/web/Dockerfile` | ✓ | 1 | SEC-073 |
| `apps/web/components.json` | ✓ | 0 | - |
| `apps/web/eslint.config.mjs` | ✓ | 1 | SEC-074 |
| `apps/web/next-env.d.ts` | ✓ | 0 | - |
| `apps/web/package.json` | ✓ | 0 | - |
| `apps/web/playwright.config.ts` | ✓ | 0 | - |
| `apps/web/postcss.config.mjs` | ✓ | 0 | - |
| `apps/web/tsconfig.json` | ✓ | 0 | - |
| `apps/web/vitest.config.ts` | ✓ | 0 | - |

## infra-terraform — 10 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `infra/terraform/cloud_run.tf` | ✓ | 1 | SEC-055 |
| `infra/terraform/domain.tf` | ✓ | 1 | SEC-056 |
| `infra/terraform/drive.tf` | ✓ | 1 | SEC-057 |
| `infra/terraform/main.tf` | ✓ | 0 | - |
| `infra/terraform/media.tf` | ✓ | 0 | - |
| `infra/terraform/observability.tf` | ✓ | 0 | - |
| `infra/terraform/outputs.tf` | ✓ | 0 | - |
| `infra/terraform/secrets.tf` | ✓ | 1 | SEC-058 |
| `infra/terraform/terraform.tfvars.example` | ✓ | 0 | - |
| `infra/terraform/variables.tf` | ✓ | 2 | SEC-059, SEC-060 |

## infra-fourkeys-observability — 16 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `infra/four-keys/collector/Dockerfile` | ✓ | 0 | - |
| `infra/four-keys/collector/pyproject.toml` | ✓ | 0 | - |
| `infra/four-keys/collector/sample_events.json` | ✓ | 0 | - |
| `infra/four-keys/collector/src/fourkeys/__init__.py` | ✓ | 0 | - |
| `infra/four-keys/collector/src/fourkeys/__main__.py` | ✓ | 0 | - |
| `infra/four-keys/collector/src/fourkeys/dora.py` | ✓ | 0 | - |
| `infra/four-keys/collector/src/fourkeys/exporter.py` | ✓ | 1 | SEC-051 |
| `infra/four-keys/collector/src/fourkeys/github_source.py` | ✓ | 3 | SEC-052, SEC-053, SEC-054 |
| `infra/four-keys/collector/src/fourkeys/models.py` | ✓ | 0 | - |
| `infra/observability/grafana/provisioning/dashboards/dashboards.yaml` | ✓ | 0 | - |
| `infra/observability/grafana/provisioning/dashboards/four-keys.json` | ✓ | 0 | - |
| `infra/observability/grafana/provisioning/datasources/datasources.yaml` | ✓ | 0 | - |
| `infra/observability/loki/config.yaml` | ✓ | 0 | - |
| `infra/observability/otel/config.yaml` | ✓ | 0 | - |
| `infra/observability/prometheus/prometheus.yml` | ✓ | 0 | - |
| `infra/observability/tempo/config.yaml` | ✓ | 0 | - |

## ci-supplychain — 29 ファイル

| ファイル | 確認 | 指摘数 | finding ID |
|---|:--:|:--:|---|
| `.dockerignore` | ✓ | 0 | - |
| `.env.example` | ✓ | 2 | SEC-013, SEC-043 |
| `.github/CODEOWNERS` | ✓ | 0 | - |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | ✓ | 0 | - |
| `.github/ISSUE_TEMPLATE/config.yml` | ✓ | 0 | - |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | ✓ | 0 | - |
| `.github/dependabot.yml` | ✓ | 1 | SEC-044 |
| `.github/labeler.yml` | ✓ | 0 | - |
| `.github/labels.yml` | ✓ | 0 | - |
| `.github/workflows/ci.yml` | ✓ | 0 | - |
| `.github/workflows/claude-review-response.yml` | ✓ | 1 | SEC-045 |
| `.github/workflows/codeql.yml` | ✓ | 0 | - |
| `.github/workflows/dependency-review.yml` | ✓ | 0 | - |
| `.github/workflows/deploy.yml` | ✓ | 0 | - |
| `.github/workflows/labeler.yml` | ✓ | 0 | - |
| `.github/workflows/labels.yml` | ✓ | 0 | - |
| `.github/workflows/llm-eval.yml` | ✓ | 0 | - |
| `.github/workflows/review-status.yml` | ✓ | 0 | - |
| `.github/workflows/scorecard.yml` | ✓ | 0 | - |
| `.github/workflows/security.yml` | ✓ | 1 | SEC-014 |
| `.github/workflows/terraform.yml` | ✓ | 0 | - |
| `.gitleaks.toml` | ✓ | 1 | SEC-046 |
| `docker-compose.tools.yml` | ✓ | 2 | SEC-015, SEC-047 |
| `docker-compose.yml` | ✓ | 2 | SEC-048, SEC-049 |
| `justfile` | ✓ | 0 | - |
| `scripts/check-no-comments.mjs` | ✓ | 0 | - |
| `scripts/check_no_comments.py` | ✓ | 1 | SEC-050 |
| `scripts/gen-docs-index.py` | ✓ | 0 | - |
| `scripts/verify-local.sh` | ✓ | 0 | - |

---

## 集計

- 対象総数: **247**
- 確認済み: **247**
- 未確認: **0**
- 確定 finding が紐づくファイル数: **59**
- 確定 finding 総数: **84**

すべての監査対象ファイルがいずれかの監査単位に割り当てられ、確認済み。
