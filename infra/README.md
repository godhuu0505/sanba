# Infrastructure

IaC for the Google Cloud footprint, plus Elasticsearch notes.

## Layout

- `terraform/` — Cloud Run service, Artifact Registry repo, required APIs, and a
  least-privilege runtime service account (Vertex AI + Cloud Trace). Review and
  pin provider versions before applying.
- `../cloudbuild.yaml` — build → push → deploy pipeline for CD.

## Apply

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in project_id, image, ...
terraform init
terraform apply
```

The `image` variable expects an Artifact Registry tag that Cloud Build has
pushed. For a first manual deploy you can also skip Terraform and use:

```bash
gcloud run deploy voice-requirements-interviewer --source . --region us-central1 \
  --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=us-central1
```

## Elasticsearch (sponsor tech)

Elasticsearch powers the Agentic RAG grounding and past-session recall tools.
Provision it separately (Elastic Cloud is simplest), then pass credentials to
Cloud Run:

```bash
gcloud run services update voice-requirements-interviewer --region us-central1 \
  --set-env-vars=ELASTICSEARCH_URL=https://...,ELASTICSEARCH_API_KEY=...
```

Indices are created on first write. Seed domain knowledge with
`python scripts/seed_knowledge.py data/knowledge.sample.json`.

Without Elasticsearch the app still runs — the RAG/recall tools return a clear
"not configured" status and session logs fall back to `./.grill/<slug>.md`.
