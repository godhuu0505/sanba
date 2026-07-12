variable "agent_id" {
  description = "A2A agent identifier exposed by the facade"
  type        = string
  default     = "sanba-sre-scout"
}

variable "agent_instructions" {
  description = "Per-request system prompt injected into the backend (index schema and query examples; ADR-0069 Phase 0.5)"
  type        = string
  default     = <<-EOT
    SANBA の分析イベントは Elasticsearch の data stream `sanba-analytics-events` にある。
    主要フィールド: `session_id`(keyword, 例 sess-b9e27a56)、`event_type`(keyword,
    例 session_summary / ai_usage)、`@timestamp`、`payload.ai_usd`、
    `payload.components.<name>.usd`、`payload.kpi.*`。
    セッション指定の検索は必ず {"query":{"term":{"session_id":"<id>"}}} の term クエリを使うこと。
    elasticsearch_list_indices は権限不足で失敗するため使わず、elasticsearch_search と
    elasticsearch_mappings のみを使うこと。
  EOT
}

variable "developer_members" {
  description = "IAM members allowed to invoke the facade (must already hold production log-read access; ADR-0069 decision 3)"
  type        = list(string)
  default     = []
}

variable "elasticsearch_url" {
  description = "Elasticsearch endpoint the HolmesGPT sidecar queries read-only"
  type        = string
}

variable "holmes_model" {
  description = "litellm model identifier for HolmesGPT (ADR-0061: Vertex AI Gemini)"
  type        = string
  default     = "vertex_ai/gemini-2.5-pro"
}

variable "image_tag" {
  description = "Immutable tag (git short SHA) of the facade and sidecar images in Artifact Registry"
  type        = string
}

variable "public_url" {
  description = "Public HTTPS URL of this Cloud Run service used in A2A agent card discovery (run 'terraform output facade_url' after first apply to get the value)"
  type        = string
  default     = ""
}

variable "project_id" {
  description = "GCP project hosting the external-agent runtime (quota-isolated from production; ADR-0069 decision 4)"
  type        = string
  default     = "sanba-ops"
}

variable "region" {
  description = "GCP region for Cloud Run and Artifact Registry"
  type        = string
  default     = "us-central1"
}
