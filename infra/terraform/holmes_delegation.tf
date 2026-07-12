resource "google_service_account" "holmes_invoker" {
  account_id   = "holmes-invoker"
  display_name = "Voice agent -> A2A facade (sanba-ops) delegation invoker (issue #547)"
  depends_on   = [google_project_service.services]
}

resource "google_service_account_iam_member" "runtime_impersonates_holmes_invoker" {
  service_account_id = google_service_account.holmes_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

output "holmes_invoker_service_account" {
  value       = google_service_account.holmes_invoker.email
  description = "Dedicated SA the voice agent impersonates to invoke the ops A2A facade (grant it run.invoker in terraform-ops)."
}
