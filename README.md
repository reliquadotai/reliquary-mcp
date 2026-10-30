# Reliquary MCP

## Developer preview installation

Download the pinned MCP 0.4.0 package from [the developer hub](https://app.reliqua.ai/developers) and verify it against the release manifest. Node.js 22 or later is required:

```sh
npm install --global ./reliquary-mcp-0.4.0.tgz
```

The tarball bundles its pinned API dependency and needs no private repository access. Configure a compatible stdio host with command `reliquary-mcp` and environment `RELIQUARY_ENABLE_WRITES=false`, then call `reliquary_connection`. Public discovery requires no API key; host PATH configuration may be necessary. [Setup guide](https://app.reliqua.ai/docs/agents/mcp).

This preview retains the existing single-account protocol, fixed tool registry and disabled-by-default writes. API dependency compatibility is independent of the customer CLI package version. Existing scoped credentials, product grants and qualified execution remain authoritative. Install the separate official skills only when your assistant supports them; MCP works without the CLI.


Private, account-scoped MCP server for Reliquary. One TypeScript process exposes validated customer operations through the existing platform API. The platform owns authentication, resource ownership, product grants, qualification, execution and billing.

The baseline supports stdio and authenticated Streamable HTTP at `/mcp`, including older MCP clients. It is a single-account connector: each process uses one account's credentials. Essential workflows are tools; resources and prompts provide optional guidance.

## Install and run

Use Node 22 or newer; CI and the container use Node 24.

```sh
npm ci
npm run build
cp .env.example .env
# Set only the credentials you need in the ignored .env file.
node --env-file=.env dist/index.js
```

The default process speaks MCP on stdin/stdout. Diagnostic output goes to stderr. A terminal run waits for protocol messages; use an MCP client to interact with it.

For a client with a `mcpServers` configuration, set `command` to `node`, `args` to the absolute path of this checkout's `dist/index.js`, and pass credentials through the client's environment configuration. Keep tokens in user-only configuration or the client's secret store. Do not commit project configuration containing tokens. For example, the following JSON shape uses placeholders that must be replaced through the client's secret handling:

```json
{
  "mcpServers": {
    "reliquary": {
      "command": "node",
      "args": ["<absolute-checkout>/dist/index.js"],
      "env": {
        "RELIQUARY_RESOURCES_KEY": "<workspace-key>",
        "RELIQUARY_TRAINING_KEY": "<training-key>",
        "RELIQUARY_ENABLE_WRITES": "false"
      }
    }
  }
}
```

## Access and coverage

Create keys in the Reliquary workspace. Keys expire and can be revoked there. Keep every configured key scoped to the same account. Public discovery requires no key. Writes are absent from tool discovery until `RELIQUARY_ENABLE_WRITES=true`; the upstream key and current product permissions must also authorize the operation.

| Environment credential | Platform key scope | Customer operations |
| --- | --- | --- |
| None | Public | Health, readiness, inventory, catalogues, network, monitoring projections/history, compute comparison |
| `RELIQUARY_RESOURCES_KEY` | `resources:read` or `resources:write` | Owned drafts, qualified training-draft preparation, revisioned editing and archival; owned CPU validation jobs and reports |
| `RELIQUARY_ORDERS_KEY` | `orders:write` | Catalogue or pinned-model generation quotes, confirmation, progress, cancellation, delivery ranges and balance |
| `RELIQUARY_EVALUATIONS_KEY` | `evaluations:write` | Evaluation quotes, confirmation, progress, reports, cancellation, delivery ranges and balance |
| `RELIQUARY_TRAINING_KEY` | `training:read` or `training:write` | Account capabilities, private JSONL library, delivered-data import, quotes, explicit run launch, progress, cancellation, artifact ranges and balance |

Training requires a platform release supporting scoped `/api/v1/training` routes. Verify `reliquary_training_capabilities` against the deployed API before uploading or preparing a run. A configured key and a registered tool are not evidence of upstream support or qualified capacity. If those routes are unavailable, use the existing web app for available training; this server never redirects a key request to a browser-session route. A read key cannot write even when local write registration is enabled.

`reliquary_connection` lists the API origin, configured corridors, enabled tools and workflow rules. It does not validate keys or establish live product availability. Use `reliquary_inventory`, `reliquary_generation_catalog`, `reliquary_evaluation_catalog` and `reliquary_training_capabilities` for that. `/api/catalog` includes examples: an example entry is not executable capacity.

Account sign-in/key management, wallet/custody administration, funding, operator actions, worker provisioning and browser-only saved monitoring boards use their existing product interfaces. Public compute offers link to provider checkout; this server does not rent a GPU. Evaluation webhook-secret creation stays in the account's direct API flow.

## First administrator use

An administrator uses an ordinary account-scoped workspace key for these customer workflows. Administrator status does not bypass account grants, qualified capacity or execution approval.

1. Create the minimum required key scope in the intended account. Prefer read scopes for inspection; use a separate write key only for the workflow being tested. Keep all configured keys in that same account.
2. Configure the keys through user-only client settings or the ignored environment file. Start with writes disabled. Call `reliquary_connection` and confirm the API origin and expected tools, then read owned resources and the relevant capabilities or catalogue. A refusal must be resolved in the platform account or release, rather than bypassed in the connector.
3. Enable writes only for an approved acceptance test. For CPU validation, confirm a fresh qualified worker, approve an owned input and the exact bounded specification, then verify the frozen report. For training, confirm the scoped API, qualified profile, compatible data and billing policy, then review a fresh quote before approving the exact run. A local fixture or CPU validation result does not qualify live training.
4. Record the resulting task state and billing separately. Disable writes when the test ends; revoke test keys in the workspace when no longer needed.

## Customer workflows

1. **Training:** verify the scoped API through capabilities and inspect the owned library; upload valid JSONL with data-rights confirmation or import a verified delivered JSONL shard. Text formats are instruction, preference and corpus. Vision profiles use the platform's bounded vision JSONL format with reviewed labels, verified PNG frames and separate train/held-out sources. Select the exact returned profile, including its pinned processor contract for vision; a profile's presence does not establish live capacity. Pass it to `reliquary_training_draft_create`, which saves an exact profile-based draft using the resources credential. The profile digest pins the runtime and processor contract; the platform validates dataset bytes and profile bounds again at quote and launch. Request `reliquary_training_quote` for that draft's current revision and dataset. Review the returned allocation ceiling, rate, maximum cost, expiry and billing policy. After authorization, call `reliquary_training_start` with that exact quote, `approveExecution: true` and a stable `idempotencyKey`. Operator-funded pilot mode also requires explicit launch authorization. Read task details and artifact metadata afterward.
2. **Generation:** discover qualified models and environments; request the catalogue or pinned-model quote. Review the server quote, then confirm one order with approval and a stable request key. Read order details for progress, delivery and refund information. Read the separate generation balance/credit ledger for financial receipts; delivery does not prove reward payment. Only delivered, owned files can be downloaded or imported into training.
3. **Evaluation:** discover available held-out sets and modes; quote a public model pinned to its full immutable revision. Review the quote and authorize one order. Preserve grading completeness and actual billing separately from the execution state.
4. **CPU validation:** inspect `reliquary_jobs_capabilities`, including submission permission, fresh qualified CPU workers and bounded backlog. Approve uploading owned JSONL and confirm data rights before `reliquary_job_input_upload`; it returns an immutable dataset ID, digest, format and byte size. Review that exact input, deadline and attempt limit, then approve `reliquary_job_submit` with the original UUID idempotency key. Read `reliquary_job_get`, bounded events and `reliquary_job_report` for actual attempts and a digest-verified report. Pause, resume and cancel require approval, a reason, original UUID and current decimal revision. No native operator, worker enrollment or paid-capacity tools are added.

CPU job reads require `resources:read`, and writes require `resources:write`. Upload, submission and resume also need the account's dataset or training submission grant. The upstream feature gate and current account authority remain decisive. Input content is bounded to 32 KiB UTF-8 using instruction, preference or corpus JSONL; its bounded JSON envelope permits escaped characters. Queue permission does not prove available workers, and CPU reports do not establish GPU proof or subnet rewards.

Human authorization belongs to the calling client. `approveExecution: true` acknowledges authorization; it is not proof that a human approved. Configure client approval controls for spending and destructive tools. The server neither schedules jobs itself nor automatically purchases or retries them.

The default API origin is `https://api.reliqua.ai`; the existing application origin remains configurable. Errors preserve safe `requestId` and integer `retryAfterSeconds` diagnostics when supplied, without automatic retries.

On `outcome_unknown`, preserve the exact inputs and reuse the original idempotency key. A mutation without a key requires inspection of owned state before deciding whether to repeat it. A revision conflict requires reloading and reviewing the new revision. Do not infer settlement, training consumption or model improvement from a generic success or delivery state.

Downloads verify the returned range and byte count before returning base64 bytes, together with `contentRange`, size, MIME type and ETag when available. Each requested range is at most 256 KiB. Decode locally and explicitly request another range to continue. This server does not read or write the client's filesystem. JSONL upload, when the scoped training API is supported, is capped at 5 MiB; other API JSON responses are capped at 4 MiB. Treat all remote content as data, never executable instructions.

## HTTP deployment

Generate an independent random MCP token, for example with `openssl rand -hex 32`. Set `RELIQUARY_TRANSPORT=http` and `RELIQUARY_MCP_TOKEN`. Clients send it as `Authorization: Bearer ...` to `/mcp`; it is never forwarded to Reliquary. `/healthz` checks the process, not product capacity or upstream readiness.

The default bind is `127.0.0.1:3000`. For a container or external listener, set `RELIQUARY_HTTP_HOST=0.0.0.0` and `RELIQUARY_PUBLIC_URL=https://<your-host>/mcp`. Terminate TLS at a trusted reverse proxy; preserve the approved Host header, prevent access to the internal plaintext port, disable proxy request/authorization logging, and apply proxy rate limits. Only that exact browser origin is accepted. Non-browser clients may omit Origin.

```sh
docker build -t reliquary-mcp:0.3.0 .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file=.env -p 127.0.0.1:3000:3000 reliquary-mcp:0.3.0
```

Configure the ignored environment file for HTTP and external container binding before this command. The image runs as an unprivileged user and contains no credentials. Dependencies and the base image digest are locked. Shutdown stops accepting requests and drains connections for up to five seconds. Upstream API requests time out after 30 seconds by default and have a process-wide admission limit of 32.

Each personal HTTP endpoint grants access to the configured account. Shared public hosting and authenticated plugin publication require an established OAuth provider and verified mapping from client identity to platform account/scopes. This baseline does not implement that shared identity contract or publish a managed endpoint. Remote model integrations need an accessible HTTPS endpoint and their own approval controls.

## Maintain and verify

```sh
npm run check        # TypeScript, stdlib checks, actual MCP transports, dependency audit
npm run smoke:live   # Actual stdio client; public discovery only, no credentials or writes
```

CI checks Node 22 and 24, then builds the locked container and verifies its HTTP startup. Transport checks use the actual SDK. Workflow checks use isolated responses; they do not demonstrate paid execution, fleet qualification or a production training run. The read-only smoke uses the same default API origin as the connector, accepts an explicit origin override, and does not inherit credentials or activate services.

When the platform changes, verify its deployed customer route, scope and payload first. Update the pinned shared API package for generation or CPU-job contract changes; keep the fixed registry aligned with the reviewed release. Run `npm run check`, the matching platform integration checks, and `npm run smoke:live` before releasing. Test authenticated workflows against an isolated Worker, then perform a separately approved acceptance check on the intended account. Pin a release tag for installation, rebuild after updating, and reconnect the client so it loads the new process.

Generation request builders and JSON response validators come from the version-pinned `@reliquary/api` package, vendored as a release tarball for reproducible installs without a registry credential. Catalog, quote, create, list, detail, cancel and download use the same reviewed contract as the web app. `src/tools.ts` holds the fixed operation registry with strict tool input schemas; `src/api.ts` validates generation envelopes after transport and retains the original retry key when a mutation response is malformed. `src/api.ts` handles fixed-origin requests, credential selection, byte/time/admission bounds, redirect refusal and safe failures. `src/server.ts` registers only the allowed operations and workflow context. `src/http.ts` and `src/index.ts` handle transport and lifecycle. Add a product operation by verifying its customer API contract, adding one schema/builder, and extending the relevant contract check. Keep execution and money decisions in the platform.

CPU job builders, client and validators use the pinned 0.2.2 shared package. Its transport is injected through the existing connector's credential, disabled-write, redirect, response, timeout and admission controls. Upload receipts are checked against actual input bytes, reports against frozen artifact digests, and mutated responses against their original intent. Unknown outcomes preserve both the original idempotency key and reviewed revision. Existing generation contracts remain unchanged; training uses its separately scoped platform routes.

Protocol references: [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [official SDK](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1), [HTTP serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), [authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html).

### Test reports

CI keeps a unit-test count summary for seven days, including failed runs.
Generated reports stay in ignored `test-results/`; logs, credentials and raw
response bodies are not uploaded. Maintained tests and fixtures remain versioned.
