# Tendr documentation

Mintlify source for the public merchant and developer documentation. The content lives in this
directory; `docs/` at the repository root contains internal design and handover documents.

## Preview and validate

Use Node 22 LTS (the repository's `.nvmrc`). Mintlify validation refuses odd-numbered Node releases, including Node 25. With nvm, run `nvm use` from the repository root first.

From the repository root:

```bash
npm run dev:docs
npm run lint --workspace=@tendr/docs
npm run validate --workspace=@tendr/docs
npm run check:links --workspace=@tendr/docs
```

Preview: <http://localhost:3001>. The Mint CLI is pinned to `4.3.12` through the workspace scripts.
Its first invocation downloads the CLI and preview client. These commands do not start or change
payment services. `build` runs Mintlify's real strict validation, rather than a placeholder echo.

## Content and API maintenance

- `docs.json`: navigation, branding and API configuration.
- `openapi.json`: 11 merchant operations for sessions, payment links and refunds, reviewed against
  `apps/api/src/routes` and the corresponding request schemas on 10 November 2026.
- Endpoint MDX files select operations from the spec. Responses describe core fields; documented
  extensible objects can include more fields from the API.
- Dashboard-only, shopper and public invoice routes are documented separately with their
  credential boundaries. Do not advertise them as secret-key endpoints.
- `scripts/check-docs.mjs` checks navigation, route existence, endpoint coverage, JSON examples,
  internal targets and branding offline. Mintlify validates MDX, OpenAPI and the full build.
- Update schemas and examples when routes change. A route-existence check cannot prove every
  field or business rule matches; review implementation and contracts together.
- SDK 0.2.0 is a standalone, tested archive; MIT-licensed and ready for npm publication. Do not advertise a registry install or download URL until the artifact is public. Shopify remains a pilot pending platform approval.
- Public MDX pages describe the hosted service and merchant installation. Keep repository setup,
  Docker simulators and package build commands in internal repository documentation.
- The WooCommerce guide links directly to the public `woocommerce-v0.3.3` GitHub release ZIP.
  When releasing a new plugin version, publish and verify the installable ZIP first, then update
  its version and download links in the guide. Merchants should never need to build the plugin.

Brand marks come from Tendr's existing WooCommerce/FE assets. The wordmark uses Sora; headings use
Instrument Sans, matching the dashboard. Avoid claims of anonymous payments, autonomous AI money
movement or live wallet recovery/shared signing that the implementation does not support.

## Publish with Mintlify

The prepared source can be connected through Mintlify's GitHub integration:

1. Create or select the Tendr Mintlify project and connect `SonOfUri/Tendr`.
2. Select the branch containing this documentation release. Current work is on `test/api-console`;
   it must be merged if a different production documentation branch is selected.
3. In Git settings, enable **docs.json is in a subdirectory**, and set `/apps/docs` (no trailing slash).
4. Deploy and verify the generated Mintlify URL, both themes, navigation and API examples.
5. Add `docs.usetendr.tech` in Mintlify's domain settings and use the DNS values it provides.
   Do not guess the CNAME target or overwrite an existing record before checking it.

The repository work does not create a Mintlify account, enable a paid plan, publish a site or change
DNS. GitHub access/project selection and any account billing are completed by the account owner.
See [Mintlify's monorepo setup](https://www.mintlify.com/docs/deploy/monorepo).
