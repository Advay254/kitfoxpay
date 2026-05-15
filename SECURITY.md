# Security Policy

## Paystack Webhook Security

### 1. HMAC-SHA512 Signature Verification (Primary Defence)

Every incoming Paystack Webhook is verified using HMAC-SHA512 before any business logic runs:

```javascript
const hash = crypto
  .createHmac('sha512', secretKey)   // secretKey = config.paystack.secretKey
  .update(rawPayload)                 // rawPayload = express.raw() Buffer — NOT parsed JSON
  .digest('hex');

// Constant-time comparison prevents timing attacks
crypto.timingSafeEqual(
  Buffer.from(hash, 'hex'),
  Buffer.from(req.headers['x-paystack-signature'].toLowerCase(), 'hex')
);
```

**Critical implementation detail:** The webhook route is registered with `express.raw({ type: 'application/json' })` *before* `express.json()` middleware. This preserves the raw request body as a `Buffer`. If `express.json()` parses the body first, the signature check will fail because the raw bytes are lost.

The `secretKey` used here is the **same** Paystack Secret Key used for API auth (`sk_test_...` / `sk_live_...`). Paystack does not use a separate webhook secret.

### 2. IP Whitelist (Defence in Depth)

Requests are checked against Paystack's known server IPs:

```
52.31.139.75
52.49.173.169
52.214.14.220
```

This check **logs a warning** but does not hard-reject (to handle IP rotation by Paystack). The signature check is the authoritative gate. Both checks together form a defence-in-depth approach.

### 3. Always Return HTTP 200

The webhook endpoint returns `200 OK` immediately *before* processing the event. This prevents Paystack from retrying events that fail due to internal errors. Processing errors are logged server-side.

```
res.sendStatus(200);  // sent immediately
// ... async processing happens after
```

### 4. Idempotency (Duplicate Event Prevention)

Every processed event is keyed by `data.id + "_" + data.reference` in an in-memory Set:

```javascript
const idempotencyKey = `${data.id}_${data.reference}`;
if (isWebhookAlreadyProcessed(idempotencyKey)) return; // skip
markWebhookProcessed(idempotencyKey);
```

The cache evicts its oldest entry when it reaches 10,000 items to prevent unbounded memory growth.

**Production note:** For multi-process deployments or instances that restart frequently, replace the in-memory Set with a Redis key or database record with a TTL of at least 7 days (to cover Paystack's maximum retry window).

### 5. Amount Re-Verification (Anti-Tampering)

On `charge.success` events, the amount from the webhook payload is **never trusted alone**. The transaction is re-verified via `GET /transaction/verify/{reference}` and the API-returned amount is compared against the webhook amount:

```javascript
const txData = await paystackClient.verifyTransaction(reference);
if (txData.status !== 'success') return;                     // reject if not success
if (txData.amount !== webhookData.amount) return;            // reject if amount mismatch
```

This prevents a scenario where a malicious actor crafts a fake webhook claiming a higher amount was paid.

---

## Secret Key Protection

- `config.paystack.secretKey` is loaded server-side only and is **never** sent to the browser
- The Admin UI saves/loads config via authenticated API (`/api/config`) which requires session auth
- `config.js` should be in `.gitignore` (already present in the original repo)
- Logs never print the full Secret Key; only the key prefix is shown during startup validation

## Input Sanitisation

- `email` — validated with regex before sending to Paystack
- `amount` — coerced to `Number`, validated as finite and positive, rounded to integer
- `reference` — sanitised: non-alphanumeric chars (except `-`, `.`, `=`) are replaced with `_`; truncated to 255 chars
- No user-provided values are passed to `eval()`, `new Function()`, or shell commands

## Reporting a Vulnerability

Please open a private GitHub Security Advisory or email the maintainer directly. Do not open public issues for security vulnerabilities.
