# Changelog

## [1.1.0] - Paystack Gateway Integration

### Added

- **`paystack/paystack.js`** — New Paystack API client module
  - `initializeTransaction(params)` — Calls `POST /transaction/initialize`; validates email, amount, and reference format before sending
  - `verifyTransaction(reference)` — Calls `GET /transaction/verify/{reference}`; used for both callback verification and webhook double-check
  - `handleWebhook(rawPayload, signature, clientIp)` — Verifies `x-paystack-signature` (HMAC-SHA512 keyed with `secretKey`) + Paystack IP whitelist check; returns parsed event
  - Exponential backoff retry (max 3 attempts) for 5xx server errors and network timeouts
  - Zero new npm dependencies — uses Node.js built-in `https`/`crypto` modules only

- **`POST /webhook/paystack`** route in `index.js`
  - Registered with `express.raw({ type: 'application/json' })` to preserve raw Buffer for HMAC verification
  - Processes `charge.success` (with mandatory API re-verification of amount) and `charge.failed` events
  - In-memory idempotency set (keyed by `data.id + reference`) prevents duplicate processing; auto-evicts oldest entry at 10,000 items
  - Always returns HTTP `200 OK` immediately to prevent Paystack retry storms
  - Forwards payment result to merchant `notify_url` (stored in Paystack `metadata.notify_url`) in e-pay format with MD5 signature

- **Paystack config section** in `config.example.js` and `admin.js`
  - Fields: `enabled`, `secretKey`, `baseUrl`, `currency`, `channels`, `webhookPath`, `customerEmail`
  - `enabled: false` by default — zero impact on existing Jeepay users
  - Admin web UI (`/index.html`) gains a **🌍 Paystack 配置** tab with all fields, channel checkboxes, and webhook URL preview
  - Config save validates `secretKey` format (`/^sk_(test|live)_[A-Za-z0-9]+$/`) when Paystack is enabled

- **e-pay parameter mapping** (Paystack path):

  | e-pay param     | Paystack param             | Notes                            |
  |-----------------|----------------------------|----------------------------------|
  | `out_trade_no`  | `reference`                | Sanitized to alphanumeric-safe   |
  | `money`         | `amount`                   | ×100 → subunit (kobo/pesewas…)   |
  | `return_url`    | `callback_url`             | Redirect after payment           |
  | `notify_url`    | `metadata.notify_url`      | Stored for webhook routing       |
  | `pid`           | `metadata.epay_pid`        | For reconciliation               |
  | `name`          | `metadata.custom_fields[]` | Product name in metadata         |

- **Paystack debug tests** in Admin UI
  - Initialize transaction (via `mapi.php`)
  - Verify transaction (via `api.php?act=order`)
  - Simulate invalid webhook (validates rejection of bad signature)

### Changed

- **`epay.js`** — `EpayAdapter` now accepts optional `paystackClient` and `paystackConfig`; all public methods (`createOrder`, `submitOrder`, `queryOrder`, `refundOrder`) auto-route to Paystack when `paystackConfig.enabled === true`, otherwise fall through to existing Jeepay logic unchanged
- **`admin.js`** — Config GET endpoint now returns proper nested `jeepay.*` structure (fixing existing inconsistency); config PUT writes Paystack section to `config.js`
- **`index.js`** — Paystack client initialized on startup if enabled; body-parsing middleware order adjusted to ensure Webhook route receives raw Buffer

### Refund behaviour (Paystack)

Paystack programmatic refunds are **not supported** in this integration. Calling `api.php?act=refund` while Paystack is active returns a clear error message instructing the operator to use the Paystack Dashboard. This is by design and documented — no fake refund response is generated.

### Backward compatibility

Existing Jeepay installations are **fully unaffected**. Set `paystack.enabled: false` (the default) in `config.js` and behaviour is identical to v1.0.0.

---

## [1.0.0] - Initial Release

- Jeepay payment gateway adapter implementing e-pay interface standard
- Admin web UI with hot-reload config
- Support for `mapi.php`, `submit.php`, `api.php` endpoints
- MD5 signature verification on all incoming e-pay requests
