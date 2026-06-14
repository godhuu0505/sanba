variable "project_id" {
  type        = string
  description = "GCP project id"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag to deploy"
}

variable "billing_account" {
  type        = string
  default     = ""
  description = "Billing account id for the budget alert (optional)"
}

variable "monthly_budget_jpy" {
  type    = number
  default = 30000
}
