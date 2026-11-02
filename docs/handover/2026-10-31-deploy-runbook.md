# Deploy runbook: production on Railway, test now, live behind a switch

**2026-11-02 deployment update:** The hackathon deployment uses the approved environment key
vault and native passkey-controlled Intents wallets for new live stores. Follow
[the native wallet operations notes](2026-11-02-native-intents-wallets.md#operations-and-verification).
The custom-contract publication, funded parent/merchant accounts, and GCP billing steps below
are not prerequisites for this native wallet path. Existing contract accounts still need them.
Live opening still requires working payment providers and screening.

Spec: `docs/superpowers/specs/2026-10-31-deploy-design.md` (§6 live mode, §7 this runbook).
Infrastructure detail: `infra/terraform/README.md`. This runbook says what to do and in what
order; it links to that file for what each resource is instead of repeating it.

What you end up with: `pay.usetendr.tech` (checkout and payment links), `app.usetendr.tech`
(sign-in, dashboard, WooCommerce connect) and `api.usetendr.tech` on Railway, with Postgres and
Redis there too, keys in GCP KMS, theme assets in GCS, mail through Resend. Merchants can sign up
and use test mode. Live mode is built and checked with our own small funds, but stays switched off
(`LIVE_MODE_ENABLED=false`) until the merchant-account contract audit is done. Live gasless stays
off (`GASLESS_LIVE_ENABLED=false`) and so does the fee sweep (`FEE_SWEEP_ENABLED=false`).

Not touched: `usetendr.tech` (landing) and `demo.usetendr.tech` stay on Vercel. Do not change
their DNS records.

## Who does what

Every step says who does it:

- **You**: the user. Account sign-ups, payments, anything that needs your login or your keys.
- **Me, after you confirm**: Claude may run it, but only after you say yes to that exact step.

Every outward step (a push, `terraform apply`, a DNS change, an account or money action, a mainnet
or testnet transaction) is done by you, or by me only after you confirm. Nothing here runs from CI.

## Tools, all in Docker

Nothing is installed on the host. Paste these helpers into the shell you run the runbook from, at
the repository root. They pin the images; keys are passed in as environment variables, never as
arguments.

```bash
export GCP_PROJECT=<your-gcp-project-id>   # the project Terraform uses (project_id)
export GCP_REGION=us-east4                  # infra/terraform/gcp var.location default
mkdir -p "$HOME/.config/gcloud" "$HOME/.near-credentials" "$HOME/.railway"

# gcloud
gcloud() {
  docker run --rm -i $([ -t 0 ] && [ -t 1 ] && echo -t) \
    -v "$HOME/.config/gcloud:/root/.config/gcloud" -v "$PWD:/work" -w /work \
    gcr.io/google.com/cloudsdktool/google-cloud-cli:stable gcloud "$@"
}

# terraform: `tf gcp <args>` or `tf railway <args>`
tf() {
  local stack="$1"; shift
  docker run --rm -i $([ -t 0 ] && [ -t 1 ] && echo -t) \
    -v "$HOME/.config/gcloud:/root/.config/gcloud:ro" \
    -e GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json \
    -e RAILWAY_TOKEN \
    -e TF_VAR_gcp_credentials_json -e TF_VAR_asset_s3_access_key_id \
    -e TF_VAR_asset_s3_secret_access_key -e TF_VAR_resend_api_key \
    -e TF_VAR_oneclick_api_key -e TF_VAR_fx_api_key \
    -v "$PWD/infra/terraform:/tf" -w "/tf/$stack" \
    hashicorp/terraform:1.9.8 "$@"
}

# Railway CLI (only `login`, `link` and `ssh` are used: commands run inside Railway's containers)
railway() {
  docker run --rm -i $([ -t 0 ] && [ -t 1 ] && echo -t) \
    -v "$HOME/.railway:/root/.railway" -v "$PWD:/work" -w /work \
    node:22-bookworm npx --yes @railway/cli@4 "$@"
}
```

The NEAR CLI (near-cli-rs) has no official image, so build a small one once:

```bash
docker build -t tendr-near-cli - <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils libudev1 \
 && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
ENV PATH=/root/.cargo/bin:/root/.local/bin:$PATH
EOF
near() {
  docker run --rm -it -v "$HOME/.near-credentials:/root/.near-credentials" \
    -v "$PWD:/work" -w /work tendr-near-cli near "$@"
}
near --version   # write the version down in your notes; rebuild with the same release later
```

Terraform plan files hold the secrets in clear, so every plan below is written to the stack's
`.terraform/` directory (gitignored); delete it after the apply (`rm infra/terraform/*/.terraform/apply.plan`).

Keys you type go through `read -rs NAME` (no echo, nothing in shell history), then
`export NAME`. Keys for the NEAR CLI live in `~/.near-credentials` (the legacy keychain the
commands below sign with). Import an account's key once with `near account import-account` and
pick "save to legacy keychain" when asked.

If a near-cli-rs release prompts differently from the commands below, run the same command with
fewer arguments: it asks for the missing parts interactively.

## NEAR amounts (from `apps/api/src/env.ts` defaults)

| Setting                                  | Default  | Meaning                                                                                   |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `FUNDING_DAILY_CAP_YOCTO`                | 50 NEAR  | Most `funding-near` may spend per rolling 24 h, per mode (creations and top-ups together) |
| `FUNDING_PER_ACCOUNT_YOCTO`              | 1 NEAR   | Most one account may be seeded with                                                       |
| `MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO` | 0.5 NEAR | What each new merchant account is seeded with                                             |
| `MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO`   | 0.5 NEAR | One storage top-up, sent when an account's free balance covers fewer than 50 proposals    |

**One merchant account costs 0.5 NEAR at creation, plus about 0.001 NEAR of gas**, and then
0.5 NEAR per storage top-up. One proposal uses about 0.006 NEAR of storage (README "Merchant
accounts"), so a top-up is due about every 80 proposals. The daily cap allows about 100 creations
or top-ups a day.

**Global contract publish.** Publishing the merchant-account wasm is paid by the publisher. The
testnet script budgets `2 × wasm bytes × 10^19 yocto + 5 NEAR` (`onchain-publish-testnet.ts`);
for a 400 KB wasm that is about 13 NEAR. The testnet publish (step 3a) shows the real charge in
its transaction: use that figure for mainnet. `wc -c onchain/target/near/merchant-account/*.wasm`
gives the size after a build.

| Account (mainnet)             | Fund with                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tendr.near`                  | 50 NEAR (one day's cap) + the global publish charge + 2 NEAR reserve. About 60 NEAR in total.                      |
| `relayer-accounts` (implicit) | 5 NEAR. Gas only; a merchant contract call costs at most 0.03 NEAR. No alert watches it: check its balance weekly. |

| Account (testnet)             | Fund with (from the faucet, https://near-faucet.io, several requests if needed)                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tendr.testnet`               | The same: 50 NEAR + the publish budget + the mock-intents account (its wasm size × 10^19 yocto + 2 NEAR) + 2 NEAR. Test sign-up works with less; once the balance runs out, provisioning fails and needs a top-up. |
| `relayer-accounts` (implicit) | 5 NEAR (same implicit id as on mainnet).                                                                                                                                                                           |

Keep `tendr.near`'s balance near this amount and top it up from your own account
(`usetendr.near`) rather than parking more there: `funding-near` holds a full-access key to it.

---

## 1. Accounts and keys

**Who: you.**

1. **Railway.** Create an account token (Account settings → Tokens) and keep it as `RAILWAY_TOKEN`.
   Install the Railway GitHub app with access to the Tendr repository: the services build from it
   (`source_repo`), and Terraform cannot connect it for you.
2. **GCP.** A project with billing on. Log in for Terraform (application default credentials) and
   gcloud:

   ```bash
   gcloud auth login --no-launch-browser
   gcloud auth application-default login --no-launch-browser
   gcloud auth application-default set-quota-project "$GCP_PROJECT"
   gcloud services enable serviceusage.googleapis.com iam.googleapis.com \
     cloudresourcemanager.googleapis.com --project="$GCP_PROJECT"
   ```

   Terraform enables Cloud KMS and Storage itself. If the project sits in an organization, check
   that the org policy `iam.disableServiceAccountKeyCreation` (or its managed form) is not enforced:
   Terraform creates the `tendr-api` key that becomes `GCP_CREDENTIALS_JSON`.

3. **Resend.** Create an API key (sending access) → `RESEND_API_KEY`. Add the domain `usetendr.tech`
   (Domains → Add). Its DNS records go in at step 5.
4. **1Click.** An API key (a JWT) → `ONECLICK_API_KEY`. Production refuses to boot without it.
5. **Chainalysis.** A screening API key. It is a stored secret, not an env var (step 6).
6. **Open Exchange Rates.** An app id → `FX_API_KEY`. The free plan is enough to boot and for test
   mode; the paid plan with 5-minute updates is needed before live is turned on (README
   "Live checklist (FX for non-USD stores)").
7. _(Optional)_ **Reown** project id for wallet connections → `next_public_reown_project_id`, with
   `https://pay.usetendr.tech` allowed in Reown.

Check: `gcloud projects describe "$GCP_PROJECT"` answers; you hold the six values above.

## 2. The state bucket

**Who: me, after you confirm** (or you).

```bash
gcloud storage buckets create gs://tendr-tfstate --project="$GCP_PROJECT" --location=us-east4 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://tendr-tfstate --versioning
```

Check: `gcloud storage buckets describe gs://tendr-tfstate --format='value(versioning_enabled,public_access_prevention)'`
prints `True enforced`. The bucket holds every secret in state; keep it private to your account.

## 3. GCP apply

**Who: me, after you confirm the plan.**

1. Run the KMS curve check first, so a protection-level fallback can go into the variables before
   the keys exist (`infra/terraform/README.md` "gcp/"). It needs a key that may create key rings,
   so use a temporary service account and remove it afterwards:

   ```bash
   gcloud iam service-accounts create tendr-kms-verify --project="$GCP_PROJECT"
   gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
     --member="serviceAccount:tendr-kms-verify@$GCP_PROJECT.iam.gserviceaccount.com" \
     --role=roles/cloudkms.admin --condition=None
   # The key file goes in ~/.config/gcloud (the gcloud container's /root/.config/gcloud), never
   # in the repo, and is deleted when the subshell exits, even if a step fails.
   (
     KEY_FILE="$HOME/.config/gcloud/kms-verify.json"
     trap 'rm -f "$KEY_FILE"' EXIT
     gcloud iam service-accounts keys create /root/.config/gcloud/kms-verify.json \
       --iam-account="tendr-kms-verify@$GCP_PROJECT.iam.gserviceaccount.com" &&
       GCP_PROJECT_ID="$GCP_PROJECT" GCP_KMS_LOCATION="$GCP_REGION" \
         GCP_CREDENTIALS_JSON="$(cat "$KEY_FILE")" npm run kms:verify --workspace=@tendr/api
   )
   ls "$HOME/.config/gcloud/kms-verify.json" 2>/dev/null && echo 'key file left behind: delete it'
   gcloud projects remove-iam-policy-binding "$GCP_PROJECT" \
     --member="serviceAccount:tendr-kms-verify@$GCP_PROJECT.iam.gserviceaccount.com" \
     --role=roles/cloudkms.admin --condition=None
   gcloud iam service-accounts delete "tendr-kms-verify@$GCP_PROJECT.iam.gserviceaccount.com"
   ```

   Check: it prints PASS for envelope encryption, Ed25519 and secp256k1, and which protection level
   worked. If it fell back to `SOFTWARE` for an algorithm, put that key in
   `protection_level_overrides` below. The `tendr-verify` key ring stays (key rings cannot be
   deleted); its HSM key versions cost money monthly until destroyed
   (`gcloud kms keys versions destroy 1 --key=verify-ed25519 --keyring=tendr-verify --location="$GCP_REGION"`,
   same for `verify-secp256k1` and `tendr-kek`).

2. Variables: `cp infra/terraform/gcp/terraform.tfvars.example infra/terraform/gcp/terraform.tfvars`
   and set `project_id` (plus `protection_level_overrides` if step 1 asked for it).
3. Plan and apply:

   ```bash
   tf gcp init
   tf gcp plan -out=.terraform/apply.plan      # read it; then, once you confirm:
   tf gcp apply .terraform/apply.plan
   ```

Check: `tf gcp output` lists `gcp_kms_keyring = "tendr-prod"`, the `signing_key_ids`,
`service_account_email` and `assets_bucket = "tendr-assets-prod"`;
`gcloud kms keys list --keyring=tendr-prod --location="$GCP_REGION"` shows `tendr-kek` and the
signing keys.

### Read the two NEAR keys the platform signs with

**Who: me (read-only).** `funding-near` creates merchant accounts under the parent account;
`relayer-accounts` pays gas for merchant contract calls from its implicit account (the hex of its
public key). Both are the same on testnet and mainnet.

```bash
for k in funding-near relayer-accounts; do
  gcloud kms keys versions get-public-key 1 --key="$k" --keyring=tendr-prod \
    --location="$GCP_REGION" --project="$GCP_PROJECT" --output-file="/work/$k.pem"
done
(cd apps/api && npx tsx -e "
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { nearPublicKey } from './src/keyvault/keys.ts';
for (const k of ['funding-near', 'relayer-accounts']) {
  const der = createPublicKey(readFileSync('../../' + k + '.pem')).export({ type: 'spki', format: 'der' });
  const raw = new Uint8Array(der.subarray(der.length - 32));
  console.log(k, nearPublicKey(raw), Buffer.from(raw).toString('hex'));
}")
rm funding-near.pem relayer-accounts.pem
export FUNDING_NEAR_PK=ed25519:...          # from the funding-near line
export RELAYER_ACCOUNTS_ID=<64 hex chars>   # from the relayer-accounts line: its implicit account
```

Check: two lines, each with an `ed25519:` key and 64 hex characters.

## 3a. Testnet pieces (needed for test mode in production)

Production forces the rpc NEAR driver, so a test-mode sign-up creates a real
`<store>.tendr.testnet` account. This comes before the Railway apply, so the first deploy has the
testnet code hash.

1. **Fund `tendr.testnet`** (amount above). **Who: you** (faucet).
2. **Add the `funding-near` key to `tendr.testnet`.** **Who: me, after you confirm.** Creating a
   sub-account needs a full-access key; the API caps what it spends.

   ```bash
   near account import-account   # once: tendr.testnet's full-access key, saved to the legacy keychain
   near account add-key tendr.testnet grant-full-access \
     use-manually-provided-public-key "$FUNDING_NEAR_PK" \
     network-config testnet sign-with-legacy-keychain send
   ```

   Check: `near account list-keys tendr.testnet network-config testnet now` lists `$FUNDING_NEAR_PK`.

3. **Fund `relayer-accounts` on testnet** (5 NEAR). **Who: me, after you confirm.**

   ```bash
   near tokens tendr.testnet send-near "$RELAYER_ACCOUNTS_ID" '5 NEAR' \
     network-config testnet sign-with-legacy-keychain send
   ```

   Check: `near account view-account-summary "$RELAYER_ACCOUNTS_ID" network-config testnet now`
   shows the balance.

4. **Publish the testnet contracts** (README "Testnet publish"). **Who: me, after you confirm.**
   It builds `onchain/` in Docker, publishes the `testnet-admin` merchant-account build as a global
   contract from `tendr.testnet`, deploys `mock-intents` to `intents-mock.tendr.testnet`, and
   prints the code hash. Nothing is published on `tendr.testnet` yet, so this is the first run.

   ```bash
   read -rs NEAR_PUBLISH_PRIVATE_KEY && export NEAR_PUBLISH_PRIVATE_KEY   # tendr.testnet full-access key
   npm run onchain:publish:testnet --workspace=@tendr/api -- --network testnet
   unset NEAR_PUBLISH_PRIVATE_KEY
   ```

   Check: `PASS: global contract published, code hash <hash>`, a PASS for `intents-mock.tendr.testnet`,
   and PASS for every testnet asset id. Put the hash in the Railway variables as
   `merchant_account_code_hash_test` (step 4). Note the publish transaction's cost (on
   https://testnet.nearblocks.io): that is the figure for the mainnet publish.

5. **`fees.tendr.testnet` as a merchant account. Not possible yet:** see "Known gaps" below. Test
   payments credit the simulated fee through `intents-mock.tendr.testnet`, which keeps balances for
   any account id, so test mode is expected to work without it. The smoke test (step 8) confirms
   this: a test payment must settle.

## 4. Railway apply

**Who: me, after you confirm the plan.**

1. Variables that are not secrets go in `infra/terraform/railway/terraform.tfvars` (copy from
   `terraform.tfvars.example`): `source_repo` (`<owner>/<repo>`), `gcp_project_id`,
   `merchant_account_code_hash_test` (from 3a), and `next_public_reown_project_id` if you have
   one. Leave `merchant_account_code_hash_live` empty for now (step 9).
2. Secrets as environment variables, so they never touch disk:

   ```bash
   read -rs RAILWAY_TOKEN && export RAILWAY_TOKEN
   export TF_VAR_gcp_credentials_json="$(tf gcp output -raw api_credentials_json)"
   export TF_VAR_asset_s3_access_key_id="$(tf gcp output -raw assets_hmac_access_id)"
   export TF_VAR_asset_s3_secret_access_key="$(tf gcp output -raw assets_hmac_secret)"
   read -rs TF_VAR_resend_api_key && export TF_VAR_resend_api_key
   read -rs TF_VAR_oneclick_api_key && export TF_VAR_oneclick_api_key
   read -rs TF_VAR_fx_api_key && export TF_VAR_fx_api_key
   ```

3. Plan:

   ```bash
   tf railway init
   tf railway plan -out=.terraform/apply.plan
   ```

   Read the plan for:
   - the hosts: `API_BASE_URL=https://api.usetendr.tech`, `WEB_URL=https://app.usetendr.tech`,
     `CHECKOUT_BASE_URL=https://pay.usetendr.tech`, `CORS_ORIGINS=https://app.usetendr.tech`,
     `WEBAUTHN_RP_ID=usetendr.tech`, `WEBAUTHN_ORIGINS=https://app.usetendr.tech`. No `localhost`
     or `http://` anywhere. **The passkey RP ID is permanent** once someone registers a passkey;
     it must be `usetendr.tech` on the first deploy;
   - `LIVE_MODE_ENABLED`, `GASLESS_LIVE_ENABLED` and `FEE_SWEEP_ENABLED` all `"false"`;
   - `MAIL_DRIVER=resend`;

4. Apply, once you confirm:

   ```bash
   tf railway apply .terraform/apply.plan
   ```

Railway starts building as soon as the services exist, from `source_repo_branch` (`main`). Until
the push in step 6, those builds run whatever `main` holds and may fail; step 6 replaces them.

Check: `tf railway output -json custom_domain_dns` lists `pay`, `app` and `api`, each with a
`dns_record_value`. The Railway dashboard shows the project `tendr` with `api`, `worker`, `web`,
`postgres` and `redis`.

## 5. DNS at Namecheap

**Who: you** (Namecheap → Domain List → `usetendr.tech` → Advanced DNS → Host Records). Enter the
host without the domain (Namecheap appends `.usetendr.tech`). Leave `@`, `www` and `demo` alone:
they point at Vercel.

| Type  | Host                                                  | Value                                                                                                    |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CNAME | `pay`                                                 | `custom_domain_dns.pay.dns_record_value`, from `tf railway output -json custom_domain_dns`               |
| CNAME | `app`                                                 | `custom_domain_dns.app.dns_record_value`, from `terraform output`                                        |
| CNAME | `api`                                                 | `custom_domain_dns.api.dns_record_value`, from `terraform output`                                        |
| TXT   | `verification_host_label` of each domain, if not null | its `verification_record_value`, from `terraform output`                                                 |
| MX    | `send` (priority 10)                                  | the MX value from the Resend dashboard (Domains → usetendr.tech), `feedback-smtp.<region>.amazonses.com` |
| TXT   | `send`                                                | the SPF value from the Resend dashboard, `v=spf1 include:amazonses.com ~all`                             |
| TXT   | `resend._domainkey`                                   | the DKIM value from the Resend dashboard (`p=…`)                                                         |
| TXT   | `_dmarc` _(optional, recommended)_                    | `v=DMARC1; p=none;`                                                                                      |
| CNAME | `docs` _(when the docs project is connected)_         | the value Mintlify's dashboard shows for the custom domain                                               |

Use the `host_label` from the output if it differs from `pay` / `app` / `api`. Namecheap only takes
MX records under **Mail Settings → Custom MX**; switching to it turns off Namecheap's email
forwarding for the domain, so check nothing relies on that first. The `send` MX is only the
bounce/return path; it does not change where mail to `@usetendr.tech` goes.

**Docs.** `docs.usetendr.tech` is a Mintlify project you connect to this repository (docs root
`apps/docs`, which holds `docs.json`). It needs no code. Add the custom domain in Mintlify, then the
`docs` CNAME above.

Check (macOS has `dig`):

```bash
for h in pay app api; do dig +short CNAME "$h.usetendr.tech"; done
dig +short TXT resend._domainkey.usetendr.tech
```

Each returns the value you entered (allow up to 30 minutes). Railway shows each custom domain as
active with a certificate; Resend shows the domain as Verified (press Verify after the records
resolve).

## 6. The first deploy

**Who: you push, or me after you confirm.**

1. Merge the `deploy` branch into `main` and push `main`. Railway builds `api`, `worker` and `web`.
2. Watch the deploys in the Railway dashboard.

Checks:

- **api pre-deploy (the migration).** The api deploy log shows `prisma migrate deploy` applying
  the migrations (or "No pending migrations to apply"), then the roles script creating or updating
  `tendr_app`. Postgres roles: `infra/terraform/README.md` "Postgres roles".
- **The worker crash-loops until the api's pre-deploy has run.** The worker connects as
  `tendr_app`, which the api's migration creates; until then its log shows a Postgres
  authentication failure for `tendr_app` and Railway restarts it. That is expected on the first
  deploy. It turns healthy (`/health`) once the api migration has finished; if it does not within a
  few minutes of that, restart the worker once from the dashboard.
- **web listens on 3000.** The web deploy log shows Next starting on port 3000 (its `start` script
  passes `--port 3000`, and `PORT` is pinned to 3000 on web).
- `curl -sS https://api.usetendr.tech/v1/health` → `{"status":"ok"}`.
- `curl -sSI https://app.usetendr.tech/login` → `200`; `curl -sSI https://pay.usetendr.tech/privacy` → `200`.
- The least-privilege role holds (**who: me, after you confirm**):

  ```bash
  railway login --browserless   # once
  railway link                  # pick the tendr project
  railway ssh --service postgres
  # inside the container:
  psql "$APP_DATABASE_URL" -c 'UPDATE events SET type = type'     # must fail: permission denied
  psql "$APP_DATABASE_URL" -c 'CREATE TABLE x (id int)'           # must fail: permission denied
  ```

- The two checks in `infra/terraform/README.md` "Check before the first deploy":
  `X-Forwarded-For` handling and the health-check rate limit.

**The Chainalysis key** (a stored secret, purpose `chainalysis`). **Who: you type the key; me,
after you confirm, for the rest.** The operator script reads the key from stdin only. Feed it with
`printf '%s'`: a trailing space or newline from `echo` or a padded paste is stored as part of the
key.

Not `railway run --service api npm run secrets:put …`: that runs
the command on your machine (here, in the CLI's container) with the api's variables, but the api's
`DATABASE_URL` points at Railway's private network (`postgres.railway.internal`), which only
Railway's containers reach. So run it inside the api container, where the repo is built with its
dev dependencies:

```bash
railway ssh --service api
# inside the container:
read -rs KEY && printf '%s' "$KEY" | npm run secrets:put --workspace=@tendr/api -- chainalysis; unset KEY
```

If `railway ssh` is unavailable in your CLI version, the same line through
`railway run --service api -- sh -c '…'` works only from a machine on Railway's network.

Check: it prints `stored chainalysis secret <id>` and nothing else. The API picks it up within
5 minutes (its secret cache). Screening runs in live mode only, so test mode does not need it.

## 7. Seeding

None. Production gets no demo merchant: do not run `db:seed` against it.

## 8. Smoke test on the real domains, in test mode

**Who: you** (a browser, a phone or a security key for the passkey, a WordPress site).

| Step                                                                                    | Check                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up at `https://app.usetendr.tech/signup`                                           | The form submits; no CORS or origin error in the browser console.                                                                                                                                                                                                                                                             |
| Receive the magic link by email                                                         | It arrives from `Tendr <no-reply@usetendr.tech>`, links to `app.usetendr.tech`, and passes SPF and DKIM (Gmail: Show original).                                                                                                                                                                                               |
| Add a passkey                                                                           | The passkey prompt names `usetendr.tech`. The store's test account reaches `active` (dashboard account page; provisioning creates `<store>.tendr.testnet`).                                                                                                                                                                   |
| Create a test payment link                                                              | Its `url` is `https://pay.usetendr.tech/<store>/<link>?mode=test`.                                                                                                                                                                                                                                                            |
| Pay it at `pay.usetendr.tech/<store>/<link>`                                            | The test checkout opens on the pay host and the payment settles (the merchant's test balance and the payment show it).                                                                                                                                                                                                        |
| Open an old `/pay/…` URL, e.g. `https://pay.usetendr.tech/pay/<store>/<link>?mode=test` | It redirects (308) to `https://pay.usetendr.tech/<store>/<link>?mode=test`.                                                                                                                                                                                                                                                   |
| Upload a theme logo                                                                     | It uploads, and its URL starts with `https://storage.googleapis.com/tendr-assets-prod/`. That URL opens in a new tab. This is the GCS S3-interop check of spec §4.                                                                                                                                                            |
| Connect a WooCommerce store against production                                          | Build the zip locally (`npm run build:zip --workspace=@tendr/woocommerce`) and upload it to a WordPress site with pretty permalinks (the public download serves no zip yet: see "Known gaps"). Connect opens `app.usetendr.tech/connect`; the settings page shows "Connected to …"; a test order pays on `pay.usetendr.tech`. |

Also expected while live is off: going live in the dashboard lists "live mode unavailable" first,
and **the live keys the WooCommerce connect issues cannot write**: a write with them answers
`403 LIVE_MODE_UNAVAILABLE`. That is by design (they turn usable when live is switched on).

## 9. Mainnet pieces (spec §6)

Set up now, checked with our own small funds. Every money-moving step is confirmed with you first.

1. **KMS keys exist and `kms:verify` passes.** Done in step 3. Check:
   `gcloud kms keys list --keyring=tendr-prod --location="$GCP_REGION"` shows `funding-near` and
   `relayer-accounts`.
2. **Fund `tendr.near` and add the `funding-near` key.** **Who: you fund; me, after you confirm,
   add the key.** Amount: about 60 NEAR (table above).

   ```bash
   near account import-account   # once: tendr.near's full-access key, saved to the legacy keychain
   near account add-key tendr.near grant-full-access \
     use-manually-provided-public-key "$FUNDING_NEAR_PK" \
     network-config mainnet sign-with-legacy-keychain send
   ```

   Check: `near account list-keys tendr.near network-config mainnet now` lists `$FUNDING_NEAR_PK`;
   `near account view-account-summary tendr.near network-config mainnet now` shows the balance.

3. **Fund `relayer-accounts` on mainnet** (5 NEAR). **Who: me, after you confirm.**

   ```bash
   near tokens tendr.near send-near "$RELAYER_ACCOUNTS_ID" '5 NEAR' \
     network-config mainnet sign-with-legacy-keychain send
   ```

   Check: `near account view-account-summary "$RELAYER_ACCOUNTS_ID" network-config mainnet now`.

4. **`fees.tendr.near` as a merchant account. Blocked:** see "Known gaps". Until it exists, the
   checkout check below pays its fee share to `fees.tendr.near`'s intents balance by default (an
   intents balance is kept by account id, so it is not lost: only `tendr.near` can create that
   account), or pass `--fee-account` to an account you control.
5. **Build and publish the merchant-account contract as a global contract.** There is no mainnet
   publish script; these are the steps. **Who: me, after you confirm** (the publish spends NEAR).
   1. Build reproducibly in Docker, default features (never `testnet-admin` or `probe` on mainnet):

      ```bash
      onchain/scripts/build.sh merchant-account
      wc -c onchain/target/near/merchant-account/merchant-account.wasm
      ```

   2. Compute its code hash (base58 of the wasm's sha256, the NEP-591 hash the API checks):

      ```bash
      (cd apps/api && npx tsx -e "
      import { readFileSync } from 'node:fs';
      import { codeHashB58 } from './scripts/lib/near-script.ts';
      console.log(codeHashB58(new Uint8Array(readFileSync('../../onchain/target/near/merchant-account/merchant-account.wasm'))));")
      ```

      Run the build twice (or on a second machine): the hash must be the same each time.

   3. Publish it as a global contract by hash, from `tendr.near`:

      ```bash
      near contract deploy-as-global use-file onchain/target/near/merchant-account/merchant-account.wasm \
        as-global-hash tendr.near network-config mainnet sign-with-legacy-keychain send
      ```

      Check: the transaction succeeds (https://nearblocks.io) and the code hash the CLI reports
      equals the one from step 2.

   4. Set `merchant_account_code_hash_live` to that hash in
      `infra/terraform/railway/terraform.tfvars`, then `tf railway plan -out=.terraform/apply.plan` (only
      `MERCHANT_ACCOUNT_CODE_HASH_LIVE` on api and worker should change) and, once you confirm,
      `tf railway apply .terraform/apply.plan`.

   **The audit must cover this exact hash.** Write it down with the commit it was built from. If
   the audit changes the code, rebuild, publish the new hash and update the variable before live is
   turned on. While `LIVE_MODE_ENABLED` is false no merchant account is created from it; only our
   own check scripts touch mainnet.

6. **Outside keys.** `ONECLICK_API_KEY` and `FX_API_KEY` are set (step 4), the Chainalysis secret
   is stored (step 6). The OXR plan stays free until live is turned on.
7. **The two mainnet checks**, with your own funded account (e.g. `usetendr.near`, never
   `tendr.near`). **Who: you, or me after you confirm.** Both print a spend plan and ask you to
   confirm before spending.
   - Checkout (README "Mainnet checks for checkout", capped at 5 USD; the account needs about
     0.2 NEAR and 4 USDT on NEAR):

     ```bash
     export VERIFY_FUNDER_ACCOUNT_ID=usetendr.near
     read -rs VERIFY_FUNDER_PRIVATE_KEY && export VERIFY_FUNDER_PRIVATE_KEY
     read -rs ONECLICK_API_KEY && export ONECLICK_API_KEY
     read -rs VERIFY_CHAINALYSIS_API_KEY && export VERIFY_CHAINALYSIS_API_KEY
     npm run checkout:verify:mainnet --workspace=@tendr/api -- \
       --yes-i-understand-this-spends-mainnet-funds
     npm run checkout:verify:mainnet --workspace=@tendr/api -- \
       --yes-i-understand-this-spends-mainnet-funds --phase cleanup
     ```

   - Merchant account (README "Merchant accounts (NEAR)", "Mainnet checks"; two phases 24 h apart;
     about 3.9 + 4.8 NEAR that come back, about 0.06 NEAR that does not):

     ```bash
     onchain/scripts/build.sh && onchain/scripts/build.sh --features probe merchant-account
     npm run onchain:verify:mainnet --workspace=@tendr/api -- \
       --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase prepare
     # 24 hours later:
     npm run onchain:verify:mainnet --workspace=@tendr/api -- \
       --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase finish --cleanup
     ```

   Check: every check prints PASS (or the INFO the README describes), and cleanup returns the
   balances. Neither script goes through the API, so both run while the switch is off.

## 10. Turning live on (later)

**Who: you decide; me, after you confirm, for the apply.** Do these in order:

1. **The audit is done, and the published hash is the audited one.** Compare
   `MERCHANT_ACCOUNT_CODE_HASH_LIVE` (Railway variables) with the hash in the audit report. If
   they differ, go back to 9.5 with the audited code first.
2. **The OXR plan is paid** (5-minute updates).
3. **`fees.tendr.near` exists as a merchant account** (see "Known gaps").
4. **Set `LIVE_MODE_ENABLED=true`.** In `infra/terraform/railway/main.tf` change
   `{ name = "LIVE_MODE_ENABLED", value = "false" }` to `"true"`. Leave `GASLESS_LIVE_ENABLED`
   and `FEE_SWEEP_ENABLED` at `"false"`: live gasless waits for the forwarder review and the README
   "Live checklist (gasless payments)". Commit, then `tf railway plan -out=.terraform/apply.plan` (only
   `LIVE_MODE_ENABLED` on api and worker changes) and `tf railway apply .terraform/apply.plan`. Railway
   redeploys api and worker.

   Check: the dashboard's go-live list no longer shows "live mode unavailable" first
   (`GET /v1/account/go-live` has no `live_mode_unavailable` in `checklist.missing`). Live keys
   from WooCommerce connect can now write.

5. **Re-queue any live provisioning skipped while the switch was off.** A live provisioning job
   that ran while `LIVE_MODE_ENABLED` was false leaves the account `provisioning` and unclaimed, and
   completes without retrying (log line `live provisioning skipped: live mode is switched off`).
   The dashboard's retry (`POST /v1/account/retry`) refuses such an account (409: it only retries a
   failed or stalled attempt), so an operator re-queues it by putting its
   `merchant_account.provision_requested` event back in the outbox; the worker then runs the
   `provision-merchant-account` job again. **Who: me, after you confirm.**

   ```bash
   railway ssh --service postgres
   # inside the container (owner connection):
   psql "$DATABASE_URL"
   ```

   ```sql
   -- Which accounts wait (normally none):
   SELECT id, merchant_id, near_account_id, created_at FROM merchant_accounts
   WHERE livemode AND status = 'provisioning' AND provision_claimed_at IS NULL;

   -- Re-queue the latest provision event of each:
   INSERT INTO event_outbox (id, event_id)
   SELECT 'obx_requeue_' || e.id, e.id
   FROM (
     SELECT DISTINCT ON (ev.aggregate_id) ev.id, ev.created_at
     FROM events ev
     JOIN merchant_accounts a ON a.id = ev.aggregate_id
     WHERE ev.type = 'merchant_account.provision_requested'
       AND a.livemode AND a.status = 'provisioning' AND a.provision_claimed_at IS NULL
     ORDER BY ev.aggregate_id, ev.created_at DESC
   ) e
   WHERE e.created_at < now() - interval '24 hours'
   ON CONFLICT (event_id) DO NOTHING;
   ```

   BullMQ keeps a completed job's id for 24 hours (`removeOnComplete`), and the job id is
   `<event id>__provision-merchant-account`, so an event re-queued sooner than 24 hours after the
   skip is dropped as a duplicate. The `WHERE` leaves those out: run the insert again a day later
   for them. Check: the first query returns no rows a minute later, and those accounts show
   `active` with a `<store>.tendr.near` account.

6. **Go live with one real merchant (ourselves)** and pay one small live order through a payment
   link and one through WooCommerce (README "WooCommerce plugin" → "Manual live checklist").
   Check the payment, the payout to the merchant account, the fee at `fees.tendr.near`, and the
   "You got paid" email.

## Known gaps (decide before the step that needs them)

- **No path creates the fee accounts.** `fees.tendr.near` and `fees.tendr.testnet` must be merchant
  accounts (passkey threshold contract, Tendr's operators as signers; README "Tendr's fee account").
  Signup cannot create them (`fees` is a reserved label) and the operator-only path is not built.
  Test mode works without `fees.tendr.testnet` (step 3a). Live needs `fees.tendr.near` before step 10.
- **The WooCommerce download serves no zip yet.** `https://pay.usetendr.tech/downloads/woocommerce`
  and the update feed read `apps/web/public/downloads/woocommerce/manifest.json`, which is still
  the `0.0.0` placeholder, and the zips are gitignored, so the Railway build has none. Publishing a
  release needs the zip in the web build (README "Releasing a version"); until then stores install
  a zip you hand them.
- **Old links.** An old `/pay/…` path on `pay.usetendr.tech` redirects to the root form (checked in
  step 8). The old `https://usetendr.tech/pay/…` form, which earlier docs showed, lands on the
  Vercel landing page, which this deploy does not change; no live store or link used it.
- **WooCommerce 0.2.0 installs do not see 0.3.0.** A store on 0.2.0 polls
  `https://usetendr.tech/v1/plugins/woocommerce/update.json` (its old default checkout base, the
  Vercel landing page) for updates, not `pay.usetendr.tech`, so it is never offered 0.3.0 and has
  to be updated by hand (upload the 0.3.0 zip). No stores are connected today, so nothing is
  stranded; if one is connected before this deploy, update it by hand.
