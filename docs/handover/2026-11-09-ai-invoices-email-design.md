# Frontend delivery brief: AI, invoices and transactional emails

Reviewed 9 November 2026 against `deploy` at `24543c8` and `test/api-console` at `f1bb3dd`. This supplements the [dashboard handover](2026-11-02-dashboard-frontend.md); its API sections remain the detailed integration contract. Fetch newer commits before implementation. The revisions identify the review baseline, not a version to reset to.

## What exists and what the FE should deliver

| Area     | Implemented                                                                                                                                                  | FE/design deliverable                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI       | Checkout assistant, route previews, merchant insight metrics/explanations, unpublished theme generation. NEAR AI Cloud integration is server-side.           | Integrate these four surfaces into the actual checkout/dashboard. The demo assistant's static responses/ranking are not the production integration.                                                                  |
| Invoices | Public contractor form, email verification, itemized totals, owner inbox, enable/pause, decline, quote review, wallet-passkey settlement and receipt states. | Refine the public invoice experience and merchant inbox while preserving the existing API and money flow. Include mobile, empty/error/expired states and the complete breakdown on both sides.                       |
| Emails   | **23 template keys**, with several distinct invoice-notice variants. Resend receives a subject and **plain text only** today.                                | Design and implement reusable transactional HTML layouts, retain plain-text alternatives, and coordinate the renderer/payload changes described below. A new React component alone does not change delivered emails. |

Use a feature branch based on `origin/deploy` and open a PR targeting `deploy`. The console branch provides functional examples and a live-API harness; preserve the production design. Changes to mail delivery code belong in the same reviewed PR as their template integration. This brief adds documentation and synthetic previews; it does not enable HTML delivery.

## AI: screens, states and interactions

The complete input/output types are in [`packages/contracts/src/ai.ts`](../../packages/contracts/src/ai.ts). Calls return ordinary JSON, not a streaming chat response. Render `answer` and fact text as text. These are bounded, read-only features, apart from explicitly creating an unpublished theme draft. There is no autonomous payment agent, recurring AI report email, or AI approval of wallet transfers.

| Surface                   | API and credentials                                                                                            | Required interaction                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout help panel       | `POST /v1/checkout/client/ai/assistant`, body `{question}`, current checkout Bearer `client_secret`            | Shopper opens help, enters a question or chooses a suggested question, sees a loading state, then the answer and relevant facts. Keep payment controls usable. No chat-history field is accepted.                       |
| Token/route comparison    | `POST /v1/checkout/client/ai/recommendations`, body `{assets:[{asset_id,balance?}]}`, same checkout credential | Compare 1–4 distinct supported assets. Display token/network, quoted input, provider ETA when available and balance caveats. Selecting a route then requests the ordinary executable quote.                             |
| Merchant insights         | `GET /v1/ai/insights?days=30`; `POST /v1/ai/insights` with `{days,question?}`                                  | Load real metric cards first; offer a separate “Explain these results” action. Dashboard cookie, store/mode headers and `account:read`; POST also needs CSRF.                                                           |
| Checkout theme generation | `POST /v1/ai/themes`, body `{name,prompt}`                                                                     | Show a generation form, then open the returned unpublished theme in the existing editor/preview. Dashboard session, CSRF, `settings:manage` and an `Idempotency-Key`. Publish/default remain separate existing actions. |

### Shared interaction rules

- Key in-flight requests and displayed results by checkout session or merchant + mode + reporting window. Abort or discard old responses on a context change. Clear an old assistant answer/quote comparison when its session changes; do not show another business's insight cards during loading.
- Distinguish idle, submitting, answered, no data, partial results and unavailable. Prevent repeated submissions while one request is pending. Let users retry deliberately; do not poll the model or automatically retry a paid model request in a loop.
- `401` means re-establish the appropriate session; `403` means the member lacks permission. For `409` checkout-state conflicts, refresh the real checkout state. For `429 RATE_LIMITED`, show a retry-later state. For `503 PROVIDER_NOT_CONFIGURED` or `PROVIDER_UNAVAILABLE`, show feature unavailable and preserve the ordinary checkout/editor/metric view.
- Checkout help answers carry `generated_at`, `facts`, `source: model_selected_facts`, `read_only: true`. They explain current backend facts; the authoritative payment status remains the session/payment API and verified webhook. Never derive a success screen from the assistant's wording.
- Questions have a 1,000-character limit. There is no server-side conversation history; any local thread is a presentation choice, kept only in memory and never sent as invented `history` fields.
- Provider credentials never reach the browser. The frontend calls Tendr, not NEAR AI Cloud. Use the server configuration in the main handover for operators only. Do not label the product “verified private”: client-to-model E2EE and independent attestation checks are not implemented.

### Route-comparison details

`recommended`, `cheapest` and `fastest` are asset IDs or null; match them to returned `routes`, not array position. A route can carry multiple labels. Display `unavailable` reasons (`unsupported`, `quote_unavailable`, `insufficient_balance`) for excluded choices. A missing balance or ETA means unknown, not zero. Wallet-reported token balance does not establish enough native gas.

The ranking basis is **quoted input USD excluding wallet gas**. Display that qualification next to a cheapest label. `expires_at` is at most 30 seconds away; mark stale previews and obtain a fresh quote before payment. `source: simulated_quotes` gets a Test label. Preview calls allocate no deposit address and replace no active quote. Preserve wallet, refund-address and gas options when asking for the final quote.

### Merchant-insight details

The date range is 1–90 days. Show current and preceding cohorts with explicit window labels and `generated_at`. Cards cover created, quoted, deposited, settled, expired-without-deposit and sessions with refunds. These are session counts, not visitors. Conversion and percentage-point change can be null; render “No data” instead of 0%. Keep currencies separate in `settled_order_totals`, which are order values, not net balances/revenue. An expired session does not establish why someone abandoned checkout.

Metric GET works without a model key. When the explanation POST fails, the metric cards should remain. A successful POST returns `{report,answer,facts,...}`: bind the explanation to that attached report, not newer cards fetched during the model call. No dedicated historical time-series endpoint is implied by this aggregate report.

### Theme-generation details

Name: 1–80 characters; prompt: 1–2,000. A 201 response contains `{theme,source:model_generated_draft,requires_publish:true}`. Keep the same idempotency key for retrying the same generation; a changed prompt/name is a new operation. An ambiguous timeout should not trigger a second generation with a new key automatically.

The server validates the generated theme and its CSS. `THEME_INVALID` creates no theme; `THEME_LIMIT` means the 20-theme library is full. Preserve the prompt on a recoverable error. Generated themes do not generate/upload logos, images, product text, testimonials or merchant identity. Review them using the existing preview and publishing controls.

### AI acceptance matrix

Exercise empty and populated metrics; live/test switching; two merchants; insufficient/unknown balances; missing ETA; one working route among failures; expired previews; late model responses; provider disabled; timeout; rate limit; theme validation rejection; full theme library; duplicate generation retry; unauthorized role. Model calls must never send money, mark a session paid or publish a theme.

The local simulator launched by `npm run dev:console` disables model calls. Use mocked response fixtures for layout/states, or the authorized live console for deliberate integration checks. Do not run production model calls automatically in a screenshot test.

## Invoices: contractor and merchant journeys

Detailed methods, request shapes and states are in [Contractor invoices](2026-11-02-dashboard-frontend.md#contractor-invoices-9-november-2026). Working references: [`InvoicePortal`](../../apps/web/src/app/invoice/[business]/portal.tsx), [`InvoiceBreakdown`](../../apps/web/src/components/InvoiceBreakdown.tsx), [`dashboard invoices`](../../apps/web/src/app/dashboard/invoices/page.tsx), [`invoice service`](../../apps/api/src/invoices/invoices.ts), [`native payouts`](../../apps/api/src/accounts/native-payouts.ts).

### Contractor: no Tendr account required

1. Open `/invoice/<business-slug>` on the app host. Load business name and supported receiving tokens with the public API. Show a clear unavailable state for a paused/nonexistent business without asking the contractor to sign in.
2. Enter name/business, email, invoice reference, optional due date, receiving network/token and external wallet. Add/remove payment-breakdown rows. Each row has a description (1–200 characters) and positive decimal-token amount; 1–50 rows are allowed.
3. Calculate a running total with integer token units, using the catalog's exact decimals. Revalidate amounts when the token changes. Do not silently round or sum with JavaScript floating point. There is no independent editable total field, automatic tax/discount calculation or fiat conversion.
4. Submit `items: [{description,amount}]` with the other fields; omit top-level `amount`/`description`. The backend calculates the total. `202 {accepted:true}` means check email, not that the business has received a verified invoice. No invoice ID/access token is returned to this caller.
5. The private email link opens the review page. Read `#token` into memory and POST it in the public `/status` body. Show the exact breakdown, total/token, full receiving address/network, business and reference. “Verify email & send invoice” POSTs `/verify`. Reading or previewing an email must never invoke verification automatically.
6. After confirmation, display awaiting payment and allow status refresh. Preserve the distinction between processing, paid, declined and payment-needs-review. The original email link remains the contractor's access to status; there is no contractor dashboard account.

All public calls use `credentials: omit`, no merchant headers and no dashboard CSRF/session cookies. Tokens must not reach analytics, logs, screenshots, URL query parameters or persistent browser storage. Keep the existing no-store/no-referrer behavior.

Duplicates use the same normalized email + business + reference. Resending an unverified submission keeps the original terms and invalidates the earlier link. Explain this in the form's success state. Correcting an already verified invoice requires declining it and submitting a new reference; there is no edit endpoint. Expired/invalid/replaced links need distinct actionable copy where the returned error permits it.

### Merchant: inbox and explicit approval

Show the selected business and Live mode. Invoicing requires its active native wallet and actual wallet owner for enable/pause, quoting, declining and payment. An owner role alone is not proof that this person controls the wallet. Other members with read permission can view the inbox. Test mode explains that invoice payment requires Live; do not silently switch mode.

| Screen/state         | Required content and controls                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page disabled        | Enable control for the eligible owner; explain active-wallet requirement. Preserve previously verified invoices.                                                                                                                     |
| Page enabled         | Public share URL, copy/open control, pause control. Use the app-host fallback until the custom invoice host works.                                                                                                                   |
| Empty inbox          | Explain that only email-verified invoices appear; show the share link.                                                                                                                                                               |
| List/detail          | Contractor name/email, reference, date/due date, amount/token, status, full breakdown, receiving network/token/address. Follow `nextCursor` (50 per page).                                                                           |
| Open                 | Select source balance, obtain a quote, or explicitly decline. A quote request sends only `{asset}`; recipient/amount come from the immutable invoice.                                                                                |
| Quote review         | Show the actual returned source asset and maximum debit including transfer costs, exact receiving total/token/network/address, and quote expiry. A reused active quote may have a different source from the newly selected dropdown. |
| Authorization        | Separate login step-up from the dedicated wallet passkey. Use `signPayout(context, reviewedPayout)`; cancellation leaves the invoice unpaid. Clear the quote/approval state on store, mode or invoice change.                        |
| Processing           | Show pending confirmation and refresh status. Disable another payment or decline. Submission/signature is not a paid receipt. An ambiguous result must be reconciled before any fresh attempt.                                       |
| Paid                 | Display confirmed status, `paidAt` and available destination transaction hashes. Preserve the original itemized total.                                                                                                               |
| Payment needs review | Explain receipt review, show invoice/payout IDs for support and disable another payment attempt.                                                                                                                                     |
| Declined             | Terminal status; show the original invoice and no pay action.                                                                                                                                                                        |

Treat the response `amount` and each `items[].amount` as **integer base-unit strings**. Legacy invoices are returned as a single line with the unchanged original amount; older API versions can omit `items`, so the existing component has the same fallback. No PDF, attachment, partial payment, recurring invoice or batch-payment endpoint exists in this release.

The invoice-native-payout path uses EXACT_OUTPUT and separately checks delivered amount against the immutable invoice total before setting `paid`. Do not substitute incoming checkout-session status/verification logic for invoice payout states. Recoverable failed/refunded payouts return to `open` only after backend reconciliation; short/missing success receipts become `payment_review`.

### Invoice acceptance matrix

Cover one and 50 rows; add/remove middle row; `0.10 + 0.20 = 0.30`; zero/negative/exponent/too-precise values; long descriptions and addresses; missing token metadata; token changes; mobile keyboard/width; total overflow; rejected client-supplied total; legacy invoice; disabled business; expired/replaced verification; duplicate reference; two stores; non-owner; declined invoice; expired/reused quote; passkey cancel; step-up; double-click; network ambiguity; processing; confirmed paid receipt; payment review. Public and merchant views must show the same saved breakdown.

## Email design and delivery contract

### Current implementation

[`mailer.ts`](../../apps/api/src/auth/mailer.ts) defines the 23 keys and `MailMessage`:

```ts
type MailMessage = {
  to: string;
  template: MailTemplate;
  data: Record<string, string>;
  subject?: string;
  text?: string;
};
```

[`renderMail`](../../apps/api/src/auth/mail-render.ts) supplies fallback subject/text. **When both `subject` and `text` are supplied, it returns them unchanged.** Invoice notices, store payment/refund notices, notification-email changes and hook-failure alerts commonly take this path. Editing fallback copy alone will not redesign those delivered messages.

[`ResendMailer`](../../apps/api/src/auth/resend-mailer.ts) POSTs `{from,to:[...],subject,text}`. There is currently no `html` field, React Email setup or Resend-hosted template ID. Production delivery uses the server's `MAIL_FROM` and `RESEND_API_KEY`; designers do not need these secrets. Local `MAIL_DRIVER=log` writes ignored `.mail/*.json`; the console's local inbox is a development tool, not a production email archive.

### Inventory: account access and invoice emails

| Template                          | Trigger and recipient                                              | Available data / action                                                                                        | Design requirements                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify_email`                    | Email sign-up for a new/unverified person; requested mailbox       | `url` → `/verify?token=…`                                                                                      | Confirm email; single-use 15-minute token. Opening the page is not a wallet registration or payment.                                                                           |
| `login_link`                      | Verified person without an active login passkey; requested mailbox | `url` → `/verify?token=…`                                                                                      | Finish sign-in/setup; single-use 15-minute token. Existing active-passkey users receive no email from this endpoint. Do not promise that every sign-in request sends mail.     |
| `invite`                          | Store-member invitation; invitee email                             | `url`, `storeName`, `role` → `/invite/<token>`                                                                 | Store and offered role, accept-invite action, 7-day lifetime. Recipient must sign in with the invited verified email.                                                          |
| `invoice_verify`                  | Public invoice submission/resend; contractor email                 | `business`, `url` → `/invoice/<slug>#token=…`                                                                  | “Review invoice”; expires for initial verification after 24 h; retain the link for later status. The current mail payload does not contain item rows, total or wallet details. |
| `invoice_notice` — submitted      | `invoice.submitted`; verified business owners                      | **`data: {}` plus authoritative `subject`/`text`**; text includes business/reference and `/dashboard/invoices` | New invoice awaiting review. The existing link is not scoped to a store/invoice; tell the owner to select the business. No payment action inside email.                        |
| `invoice_notice` — receipt review | `invoice.payment_review`; verified business owners                 | Same envelope; subject “Invoice payment needs review”                                                          | Distinct review state, never a paid receipt or “retry payment” CTA.                                                                                                            |
| `invoice_notice` — paid           | `invoice.paid` with row still paid; verified contractor            | Same envelope; text identifies business/reference, **no fresh private status URL**                             | Paid notice; direct the contractor to their original verification email for details.                                                                                           |
| `invoice_notice` — declined       | `invoice.rejected` with row still rejected; verified contractor    | Same envelope; no fresh private status URL                                                                     | Clear declined outcome, no implication that funds moved.                                                                                                                       |

Invoice handlers ignore `processing`, `open` and `settings_updated` for email delivery. There is no current “invoice reminder”, “invoice due soon” or “payment processing” email. Contractor paid/declined messages cannot reconstruct the original secret: only its hash is stored. Do not add a guessed `/invoice/:id` URL or expose merchant dashboard credentials.

### Inventory: payments, refunds and merchant notices

| Template                              | Trigger and recipient                                                                                                | Current fields/action                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_received`                    | Verified `payment.succeeded`; store notification email, else verified owner emails, only when `paymentEmailsEnabled` | Prebuilt subject/text; `store_name`, `livemode`, `payment_id`, `external_ref`, `payment_link_title`, `payer_note`, `amount_received`, `settlement_symbol`, `order_total`, `original_amount`, `fx_rate`, `fx_source`, `fx_as_of`, `paid_with`, `network_fee`, `fees`, `tx_hash`, `tx_url`, `dashboard_url`. |
| `refund_sent`                         | Confirmed refund and `refund.sent`; same store-notice recipients                                                     | Prebuilt subject/text; `store_name`, `livemode`, `refund_id`, `payment_id`, `external_ref`, `refund_external_ref`, `reason`, `amount_to_customer`, `network_fee`, `symbol`, `tx_hash`, `tx_url`, `dashboard_url`. Refund notices are not gated by the payment-received email toggle.                       |
| `refund_needs_address`                | A return needs an address and the shopper has a contact email; shopper                                               | `merchant_name`, formatted `amount`, `refund_id`, `refund_address_url` → checkout `/refund-address?t=…`. Render the provided private URL; do not create one.                                                                                                                                               |
| `payment_held`                        | `payment.held`; current store signers                                                                                | `payment_id`, `session_id`, `external_ref`, `livemode`, `held_reason`, verbatim `notice`, `url` → review queue. Preserve the server-provided non-custodial notice.                                                                                                                                         |
| `payment_screening_unresolved`        | Screening retries unresolved; current store signers                                                                  | Common payment fields above, `attempts`, `url`. Review needed, not a sanctions finding or paid confirmation.                                                                                                                                                                                               |
| `refund_needs_review`                 | `refund.needs_review`; current store signers                                                                         | Common fields, `refund_id`, `proposal_id`, `review_reason`, review-queue `url`.                                                                                                                                                                                                                            |
| `notification_email_verify`           | Requested notification-address change; pending new address                                                           | Prebuilt copy; `store_name`, `email`, `url` → `/settings/notification-email/verify?token=…`. One-use 24-hour link. Notices do not move there until confirmation.                                                                                                                                           |
| `notification_email_change_requested` | Same request; previous address or owners pinned when requested                                                       | Prebuilt copy; `store_name`, `masked_new_email`, `requested_from`. Explain current delivery continues until verified. No action URL supplied.                                                                                                                                                              |
| `notification_email_changed`          | New address verified or notification address cleared; previous address/owners pinned in the event                    | Prebuilt copy; `store_name`, `new_email` (empty = owner-email fallback). This is a change notice, not another verification request.                                                                                                                                                                        |
| `hook_failed`                         | Integrator contract hook still fails after the retry window; store notification email or verified owners             | Prebuilt copy; `store_name`, `livemode`, `payment_id`, `external_ref`, `contract`, `chain`, `attempts`, `last_error`, `dashboard_url`. Payment is already settled; the contract callback failed. Never ask for another payment.                                                                            |

Payment/refund fields such as `amount_received` and `amount_to_customer` are already display-decimal strings when metadata is known, unlike invoice API base units. `order_total`, `paid_with`, payment `network_fee` and `fees` are formatted strings; do not parse these to recalculate finance figures. `fees` is newline-delimited current copy, not a structured fee array. Refund `network_fee` is a numeric amount string in the refund asset; preserve its `symbol`. Without asset metadata the backend can use an asset ID and base units; preserve its explicit labeling. Render payer notes as untrusted plain text, including multi-line notes.

### Inventory: contract-account approval and recovery emails

These remain supported for contract accounts. Their existence does not mean native passkey wallets have shared signing or timed recovery. Current signers are recipients unless noted.

| Template                      | Trigger                                                      | Fields / action                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proposal_needs_approval`     | Pending/timelocked account proposal                          | `kind`, `summary`, action-specific string fields, `proposalId`, `livemode`, `url` → approval detail. Review the full action before signing in the dashboard. |
| `timelock_started`            | Approved proposal enters its delay                           | Same action data, `readyAt`, `cancelUrl`. Show the actual deadline and cancel/review action.                                                                 |
| `proposal_executed`           | Account proposal executes; also notifies a removed signer    | Same action data with `url`; completed tense. Do not retain a “takes effect after approval” warning for an already executed action.                          |
| `recovery_started`            | Contract recovery starts                                     | `recoveryId`, `executesAt`, `newSignerIds`, `livemode`, `cancelUrl`. Explain unexpected recovery and review/cancel action.                                   |
| `recovery_executes_soon`      | Scheduled for 24 h before execution, only while pending      | `recoveryId`, `executesAt`, `livemode`, `cancelUrl`. Distinct urgency from the first notice.                                                                 |
| `recovery_register_link`      | Recovery mailbox step; requesting person                     | `store`, `url` → `/recover/passkey?token=…`, single-use 15-minute lifetime.                                                                                  |
| `recovery_session_opened`     | Recovery session opens; person and current signers           | `person`, ISO `at`. Informational security alert; no action URL supplied.                                                                                    |
| `recovery_passkey_registered` | Recovery registers a new passkey; person and current signers | `person`, ISO `at`. Distinct from normal account sign-up; no action URL supplied.                                                                            |

Account-action summaries and extra fields are assembled by [`account-notices.ts`](../../apps/api/src/jobs/account-notices.ts). Preserve destination/network, signer/key fingerprint, threshold, code-hash/release warning and delay facts where present. Never invent native-wallet recovery controls from these templates.

### Email design components and backend work

Deliver a common shell (logo, preheader, title, supporting copy, primary action, copyable fallback URL, footer), information rows, a money summary, a status badge, a security/deadline block and Test-mode treatment. Priority: access verification, invoice verification + four outcomes, payment receipt/refund, then remaining security and settings variants. Keep line-item tables as an optional component until their structured email payload is added; the web invoice review already has the breakdown.

The HTML implementation must:

1. Extend the server render contract to return `{subject,text,html}` and pass `html` through `ResendMailer`; retain the existing text for clients that prefer it. A React-based renderer is optional. There are no hosted template IDs to modify today.
2. Preserve handler-generated subjects and the facts in prebuilt text. Do not fall back to the sparse generic `payment_received`/`invoice_notice` copy and lose payment details. Add structured/versioned payloads where the design needs data that only exists inside current text; do not parse subject lines to determine business states.
3. For richer invoice notices, agree on a server-supplied discriminant such as `notice_kind: submitted | payment_review | paid | rejected`, business/reference and optional item/amount/receipt fields. **These proposed fields are not present today.** Preserve the recipient and state checks in the handler. A new contractor access-link lifecycle needs backend design; a renderer cannot recover the existing private token.
4. Preserve URL query and fragment values exactly, including `#token` on invoice links. Keep auth links out of tracking/analytics and avoid link rewriting that loses the fragment. Do not turn email image loads or link previews into a verification, decline, approval or transfer.
5. Escape user/merchant/model text. Use supplied, validated URLs for actions; no arbitrary payer-note HTML, scripts, forms, wallet-signing requests or remote content that includes secrets. The email sends the person to the application for sensitive actions.
6. Retain the backend's Test prefixes and “no real money moved” statements. Some templates have no `livemode` (identity emails and live-only invoice emails); do not manufacture mode from the viewer's current tab.
7. Use email-compatible HTML/CSS, accessible text links and alt text, mobile sizing, wrap long references/addresses, preserve amounts exactly, and make key content understandable with images off and in dark mode. Avoid relying on browser-only layout or external web fonts.

Existing event delivery/retries and recipient deduplication remain server responsibilities. A frontend page visit must never send a duplicate notice. Some alerts have no CTA in their payload: design an informational variant instead of a dead button.

### Preview assets, review and handoff

- [`email-design-fixtures.json`](email-design-fixtures.json) contains synthetic `MailMessage` inputs for every template, the four invoice outcomes, Test-mode and notification-address fallback variants. URLs use reserved `.invalid` hosts; token strings are deliberately unusable. No production mailbox content is included.
- [`email-preview.html`](email-preview.html) is an offline baseline gallery of the **current rendered subject/plain text**, not a proposed HTML email design. It includes the input payload so designers can see which fields actually exist.
- Regenerate and validate coverage from the repository root: `node --import tsx docs/handover/preview-email-fixtures.mts`. This calls only the local renderer, performs no API/provider calls and sends no emails. Do not replace fixtures with captured production links or `.mail` files.
- When HTML rendering is implemented, expand `mail-render.test.ts` and `resend-mailer.test.ts` to cover HTML plus text, supplied subject/text overrides, escaping, exact private URLs, Test labels, every template and invoice outcome. Verify the network payload using the existing injected/mock `fetch`.
- Preview the HTML and text variants at mobile/desktop widths, with images blocked and long content; check Gmail, Apple Mail and Outlook rendering before release. Verify recipient, CTA target and expiry language as carefully as visual layout. Real delivery tests require an explicitly selected test mailbox and no real payment.

FE completion means: implemented UI with all states above, reusable email components and integration changes (if HTML is in scope), synthetic previews, design assets, passing relevant tests and documented remaining backend dependencies. Keep a screenshot/design checklist separate from claims that live money or email delivery was tested.

## Source map for implementation review

| Source                                                                                                             | Responsibility                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `apps/api/src/routes/{checkout-ai,merchant-ai,invoices}.ts`                                                        | Authentication, permission/step-up, methods and schemas.                              |
| `apps/api/src/ai/`, `packages/contracts/src/ai.ts`                                                                 | Grounded AI facts, calculations, budgets and response types.                          |
| `packages/contracts/src/invoices.ts`, `apps/api/src/invoices/invoices.ts`                                          | Item rules, exact amounts, immutable verification and invoice views.                  |
| `apps/api/src/accounts/native-payouts.ts`                                                                          | Owner quote/sign/submit/reconcile path and invoice paid/review decisions.             |
| `apps/api/src/auth/{mailer,mail-render,resend-mailer}.ts`                                                          | Template keys, renderer and actual Resend wire payload.                               |
| `apps/api/src/jobs/{invoice-notices,payment-notices,notification-email-notices,review-notices,account-notices}.ts` | Business triggers, recipient rules, fields and prebuilt copy.                         |
| `apps/api/src/merchants/{store-notices,notification-email,invites}.ts`                                             | Verified destinations, notice preferences, membership invitations and link lifecycle. |
| `apps/api/src/checkout/refunds.ts`, `apps/api/src/hooks/hooks.ts`                                                  | Shopper refund-address emails and settled-payment hook failure notices.               |

Custom invoice-host DNS is an operator item, not an FE workaround. On the last live check on 9 November, `invoice.usetendr.tech` returned Vercel `DEPLOYMENT_NOT_FOUND`; `https://app.usetendr.tech/invoice/<business-slug>` was the working fallback. The app host and its passkey origin must remain intact. Check DNS again before replacing the fallback in customer-facing links.
