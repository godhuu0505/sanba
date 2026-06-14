variable "project_id" {
  type        = string
  description = "Google Cloud project id."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Region for Cloud Run + Artifact Registry."
}

variable "service_name" {
  type        = string
  default     = "voice-requirements-interviewer"
  description = "Cloud Run service name."
}

variable "image" {
  type        = string
  description = "Container image (Artifact Registry path). Cloud Build pushes this; pass the tag to apply."
}
