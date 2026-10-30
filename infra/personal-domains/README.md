# sanba.net personal application domains

This Terraform root manages only the signed DNS zone and a shared global
external Application Load Balancer for wkwk, mnmn and mfmf. It does not manage
application data, Cloud Run service deployments, authentication settings or
the legacy SANBA application. Do not run the legacy infra/terraform root to
restore the old youken configuration.

## Recovery evidence (2026-10-30 JST)

Cloud Audit Logs record removal of the four old A records and deletion of
sanba-net on 2026-08-08. The registered NS and DS still referenced that deleted
zone. Cloud DNS listed no zones; Storage listed no buckets; GitHub repository
and production environment variables/secrets for the old Terraform workflow
were empty. Compute API was disabled; after enabling it, forwarding rules,
addresses, URL maps, certificates and backend services were empty. No old
Terraform state or live resource was adopted or overwritten.

The project had no billing account. It was linked to the same active billing
account as the three application projects. A new private, versioned state
bucket was bootstrapped with uniform access and public access prevention:
gs://sanba-prd-personal-domain-state. This root uses the distinct prefix
terraform/personal-domains; it never uses a local state or the old prefix.
The bucket is a bootstrap prerequisite, not a resource destroyed by this root.

## Operation

Use existing owner gcloud authentication, without printing or saving its token.
Supply a short-lived GOOGLE_OAUTH_ACCESS_TOKEN to Terraform in process memory.
Run Terraform 1.17.1 or later with the committed provider lockfile:

```
terraform init -backend-config=bucket=sanba-prd-personal-domain-state -backend-config=prefix=terraform/personal-domains
terraform plan -out=domains.plan
terraform apply domains.plan
```

Review plans before apply. The initial reviewed plan created 19 resources and
changed/destroyed none. A subsequent refresh plan found no differences.
No application IAM or ingress was broadened. Cloud Run services were already
publicly reachable. All app projects belong to organization 617126998262;
backend service, serverless NEG and Cloud Run remain in each app's project,
with a cross-project reference from the shared URL map.

Backend access logs are disabled because OAuth callback query strings contain
short-lived authorization codes. Load balancer metrics and the existing
application telemetry remain available; no unredacted callback URLs are added
to access logs by this configuration.

Only the three exact app hosts have DNS A records and routing rules. Unknown
hosts go to an empty backend and cannot reach an app. HTTP redirects only the
three configured hosts to HTTPS. The certificate contains only these hosts.
There are no wildcard, mnn, youken, apex or www application records/routes.
api.youken's record was deleted before this recovery, on 2026-08-08; this
operation does not recreate or delete that API or its data.

## Registrar migration: staged, not complete

New zone: sanba-net, NS ns-cloud-d1 through d4.googledomains.com, DNSSEC on.
New key tag observed at creation: 12481. Always read the current key; never
copy the old key tag 58295 or assume this new key will never rotate.

Cloud Domains rejected an NS change while DS records existed, even after
publishing both old and new DS records. Follow the service's required waiting
period. Zone signing remains on during the entire transition.

1. Parent DS cleared and absence confirmed at 2026-10-30 02:10 JST.
2. After 2026-10-31 02:15 JST, confirm DS absence in registrar and .net,
   then switch only the registration's NS to the new signed zone's current NS,
   keeping parent DS absent. Record actual completion time.
3. At least 24 hours after the NS switch, confirm delegation and new DNSKEY
   responses from all authoritative servers. Configure the registration with
   --cloud-dns-zone=sanba-net --no-disable-dnssec to publish the current DS.
4. Verify DNSSEC AD at public validating resolvers, all three A records,
   certificate ACTIVE, HTTPS, correct app routing and browser authentication.

Do not use --unsafe-dns-update, shorten the wait, or report the transition as
complete while the parent delegation is old. Do not stop zone signing.
Registrar settings are controlled with gcloud domains registrations configure
dns, separate from this Terraform root. Before each stage save only dnsSettings
and verify with --validate-only. Avoid exporting contact details or credentials.

## Application configuration

wkwk and mnmn keep their original APP_ORIGIN for existing MCP clients, with
APP_WEB_ORIGIN set to each app's sanba.net origin. mfmf keeps GCP_AUTH_ORIGIN
for MCP and sets GCP_AUTH_WEB_ORIGIN=https://mfmf.sanba.net; its server selects
the exact configured browser Host for authentication callbacks. No forwarded
host or client-supplied origin can choose an authentication destination.
Identity Platform authorizedDomains retains the old domains and adds each new
host. The existing Firebase authDomain is retained. mfmf's Google OAuth client
retains all old callbacks and adds https://mfmf.sanba.net/auth/callback.
Its private photos/avatars buckets add this exact CORS origin.

Deploy application source changes through their existing PR/CI/CD pipelines
before adding the new runtime settings. Confirm old run.app login screens,
OAuth metadata and MCP authorization responses remain working. Do not inspect
private user records to smoke test domain configuration.

## Cost and rollback

One shared LB uses two forwarding rules in sanba-prd's first-five tier:
USD 0.025/hour, about USD 18.25/730-hour month. One DNS zone is about USD
0.20/month. State storage/operations, LB processing, network traffic, Cloud Run,
Identity Platform and application storage retain their usage-based charges.
Google-managed Compute SSL certificates have no separate certificate charge.
No preexisting LB bill is being reused: those resources had already been deleted.

For application rollback, remove only the additional web-origin environment
setting and restore the previous serving revision if needed. Retain old auth
callbacks and authorized domains. DNS rollback cannot restore a deleted zone
or its private DNSSEC key. Keep this signed replacement zone; investigate
records/routing without reverting delegation to the non-serving old servers.
