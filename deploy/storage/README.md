# Private object storage

One private bucket holds two kinds of personal data:

- **Incident and election evidence** — photographs and documents that may later
  support a legal process, so their integrity has to be defensible.
- **Voter-registration documents** — PVC images and registration slips. These
  are identity documents belonging to real people.

Neither is ever public. The application reads them only through short-lived
signed URLs, and every grant and refusal is written to the audit log.

## Required bucket configuration

Provision this before the first deploy. Nothing in the compose topology creates
a bucket, and the API refuses to start in production with any storage driver
other than `s3`.

| Setting | Value | Why |
|---|---|---|
| Public access | Blocked, all four settings | A public object here is a member's identity document on the open internet. |
| Versioning | Enabled | An overwritten original is otherwise unrecoverable, and the hash recorded at upload would no longer match anything. |
| Object Lock | Enabled in governance mode, where the provider supports it | Evidence that can be silently replaced is evidence that cannot be relied on. |
| Encryption at rest | Enabled (SSE-S3 or SSE-KMS) | |
| TLS | Required | `DenyUnencryptedTransport` in the policy enforces it; the endpoint must also be `https://`. |
| Lifecycle expiry | **None** | Evidence has no expiry date, and a lifecycle rule that quietly deletes it destroys the record without an audit trail. |

## Applying the policy

`bucket-policy.json` is a template. Substitute the three placeholders:

- `BUCKET_NAME` — the bucket, e.g. `ogun-staging-private`
- `APPLICATION_PRINCIPAL_ARN` — the identity the API and worker use
- `EVIDENCE_CUSTODIAN_PRINCIPAL_ARN` — a separate, rarely used identity that may
  delete. It must not be the application principal: the application never needs
  to delete an object, and separating the two means an application credential
  leak cannot destroy evidence.

```bash
sed -e "s|BUCKET_NAME|$STORAGE_BUCKET|g" \
    -e "s|APPLICATION_PRINCIPAL_ARN|$APP_PRINCIPAL|g" \
    -e "s|EVIDENCE_CUSTODIAN_PRINCIPAL_ARN|$CUSTODIAN_PRINCIPAL|g" \
    deploy/storage/bucket-policy.json > /tmp/bucket-policy.json

aws s3api put-bucket-policy --bucket "$STORAGE_BUCKET" --policy file:///tmp/bucket-policy.json
```

On MinIO and other S3-compatible providers the policy grammar differs. The
requirements that must hold regardless of syntax are: no anonymous read, TLS
required, and delete separated from the application identity.

## Verifying it

After applying, confirm an object is genuinely unreachable without a signature:

```bash
# Expect 403. A 200 here means identity documents are publicly readable.
curl -s -o /dev/null -w '%{http_code}\n' \
  "$STORAGE_ENDPOINT/$STORAGE_BUCKET/voter-verification/probe.txt"
```

Staging and production must use different buckets. A staging instance pointed at
the production bucket lets a UAT tester open a real member's identity document.
