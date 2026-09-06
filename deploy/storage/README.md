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
| Lifecycle expiry | **None on committed objects.** One rule, on `voter-verification/pending/` only | Evidence has no expiry date, and a lifecycle rule that quietly deletes it destroys the record without an audit trail. The pending namespace is the sole exception, and it holds only bytes no database row owns yet. |

## Applying the policy

`bucket-policy.json` is a template. Substitute the three placeholders:

- `BUCKET_NAME` — the bucket, e.g. `ogun-staging-private`
- `APPLICATION_PRINCIPAL_ARN` — the identity the API and worker use
- `EVIDENCE_CUSTODIAN_PRINCIPAL_ARN` — a separate, rarely used identity that may
  delete a committed object. It must not be the application principal, so an
  application credential leak cannot destroy evidence.

## Two custody states

A document has to be written to storage before the database row that owns it
exists, because a row must never name an object that is not there. That leaves a
window in which bytes exist with no owner, and a transaction that fails inside
that window would strand an identity document with no record and no lifecycle.

So the bucket holds two kinds of object, and the policy treats them differently:

| Namespace | State | Application may delete? |
|---|---|---|
| `voter-verification/pending/*` | Uncommitted. No database row owns these yet. | **Yes**, and only here. |
| `voter-verification/<year>/<month>/*` | Committed. A row names it. | No. |
| `evidence/*` | Committed evidence. | No. |

The application is granted `DeleteObject` on the pending prefix and explicitly
denied it everywhere else, by `NotResource`. The narrowness is what makes this
safe: the alternative — letting the application delete anywhere so it can tidy
up after itself — would put permanent election evidence within reach of any bug
or leaked credential in the request path.

The same boundary is enforced in code. `discardPendingObject` refuses any key
outside the pending namespace, and `promotePendingObject` refuses to move a
document *into* it. A misconfigured policy is therefore not the only thing
standing between a cleanup and evidence destruction.

### Pending lifecycle rule

A pending object is normally removed within the same request, either by
promotion or by cleanup. A lifecycle rule is the backstop for the case where the
process dies between the two.

```json
{
  "Rules": [
    {
      "ID": "expire-uncommitted-registration-objects",
      "Status": "Enabled",
      "Filter": { "Prefix": "voter-verification/pending/" },
      "Expiration": { "Days": 1 }
    }
  ]
}
```

It must carry that prefix. A lifecycle rule without a filter, or with a broader
one, would put an expiry date on permanent election evidence — which is the
thing this bucket exists to prevent.

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
