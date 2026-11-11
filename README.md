# Reliquary MCP

## Developer preview installation

The [developer hub](https://app.reliqua.ai/docs/agents/mcp) provides the checksum-pinned 0.12.0 preview tarball and setup instructions. This MIT-licensed server requires Node.js 22 or later. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Download and verify the 0.12.0 archive using the developer hub, then install it:

```sh
npm install --global ./reliquary-mcp-0.12.0.tgz
```

For the public npm release, install the pinned version once it is available:

```sh
npm install --global @reliquadotai/mcp@0.12.1
```

When upgrading, check that `npm ls --global --depth=0 @reliquary/mcp` identifies the preview in the npm prefix you intend to use. If it does, run `npm uninstall --global @reliquary/mcp` before installing the new package. Both provide the same `reliquary-mcp` executable. Reconnect the MCP client after changing versions. To roll back, uninstall the new package and reinstall the verified preview tarball.

The tarball bundles its pinned API dependency and needs no private repository access. Configure a compatible stdio host with command `reliquary-mcp` and environment `RELIQUARY_ENABLE_WRITES=false`, then call `reliquary_connection`. Public discovery requires no API key; host PATH configuration may be necessary. [Setup guide](https://app.reliqua.ai/docs/agents/mcp).

The source candidate also supports hosted batch request preparation through `reliquary_affine_batch_prepare`, using a fresh owned qualified profile from `reliquary_training_capabilities`. It requires the training key and enabled writes but computes nothing. Upload only its exact returned request as `JSON.stringify(request)+'\n'` with `reliquary_training_upload`, format `affine_batch_request`, and confirmed data rights; this metadata is limited to 4 KiB. Raw batch files stay in the separately reviewed official-kit workflow. Save the returned configuration plus the uploaded dataset ID using `reliquary_resource_create` (separate resources authority), then use the saved revision with `reliquary_training_start`, explicit approval and a stable request key. An explicitly available operator-funded pilot omits `quoteId`. Generic training drafts and the older native diagnostic tools remain separate. Read the batch task/result and ranged artifacts through existing training tools; assemble and independently verify the signed receipt and archive using the SDK example. No signature-verification tool or automatic execution is provided. This source support does not establish hosted publication, qualification or capacity.

This preview retains the existing single-account protocol, fixed tool registry and disabled-by-default writes. API dependency compatibility is independent of the customer CLI package version. Existing scoped credentials, product grants and qualified execution remain authoritative. Discover the complete official workflow catalog with `reliquary_skills`; filter by `search`, `category`, exact `id` or `state`. `state: not-yet-available` (listed in `notYetAvailable`) marks workflows whose product is not open yet; their `availability` note says what to use instead. The tool reads the installed catalog without credentials or upstream requests. Entries retain their documented access and qualification requirements. Install the separate official skills only when your assistant supports them; MCP works without the CLI.


Account-scoped MCP server for Reliquary. One TypeScript process exposes validated customer operations through the existing platform API. The platform owns authentication, resource ownership, product grants, qualification, execution and billing.

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

The installed 0.6 catalog includes public run selection, RL progress, held-out benchmarks, raw response-token composition and declared GPU participation through `reliquary_run_catalog` and `reliquary_run_monitor`. These are stored public observations, separate from owned training tasks. Instruction links are immutable and versioned; check the release manifest on the selected origin. Reconnect a running host after upgrading and verify the runtime-reported version. SDK transport tests do not qualify every assistant host.

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

`reliquary_connection` lists the API origin, configured corridors, enabled tools, installed skill-catalog version and workflow rules. The `reliquary://skills` JSON resource provides the full catalog and installation links; the `reliquary-skill` prompt helps choose instructions for a goal without installing or executing them. `reliquary_skills` accepts optional conjunctive `search`, `category` and `id` filters; unknown IDs or categories return an empty list. Catalog entries never enable an absent tool, grant access or establish live availability. It does not validate keys or establish live product availability. Use `reliquary_inventory`, `reliquary_generation_catalog`, `reliquary_evaluation_catalog` and `reliquary_training_capabilities` for that. `/api/catalog` includes examples: an example entry is not executable capacity.

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

Downloads verify the returned range and byte count before returning base64 bytes, together with `contentRange`, size, MIME type and ETag when available. Each requested range is at most 256 KiB. Decode locally and explicitly request another range to continue. The HTTP connector does not access the client's filesystem. Local stdio batch tools can upload a user-selected file or save a delivery under a user-selected directory; local downloads remain available when upstream mutations are disabled. JSONL upload, when the scoped training API is supported, is capped at 5 MiB; other API JSON responses are capped at 4 MiB. Treat all remote content as data, never executable instructions.

## HTTP deployment

Generate an independent random MCP token, for example with `openssl rand -hex 32`. Set `RELIQUARY_TRANSPORT=http` and `RELIQUARY_MCP_TOKEN`. Clients send it as `Authorization: Bearer ...` to `/mcp`; it is never forwarded to Reliquary. `/healthz` checks the process, not product capacity or upstream readiness.

The default bind is `127.0.0.1:3000`. For a container or external listener, set `RELIQUARY_HTTP_HOST=0.0.0.0` and `RELIQUARY_PUBLIC_URL=https://<your-host>/mcp`. Terminate TLS at a trusted reverse proxy; preserve the approved Host header, prevent access to the internal plaintext port, disable proxy request/authorization logging, and apply proxy rate limits. Only that exact browser origin is accepted. Non-browser clients may omit Origin.

```sh
docker build -t reliquary-mcp:0.12.1 .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file=.env -p 127.0.0.1:3000:3000 reliquary-mcp:0.12.1
```

Configure the ignored environment file for HTTP and external container binding before this command. The image runs as an unprivileged user and contains no credentials. Dependencies and the base image digest are locked. Shutdown stops accepting requests and drains connections for up to five seconds. Upstream API requests time out after 30 seconds by default and share a process-wide admission limit of 32, including local batch transfers. Streaming downloads apply the configured deadline to response headers and remain cancellable while their bodies are written.

Each personal HTTP endpoint grants access to the configured account. Shared public hosting and authenticated plugin publication require an established OAuth provider and verified mapping from client identity to platform account/scopes. This baseline does not implement that shared identity contract or publish a managed endpoint. Remote model integrations need an accessible HTTPS endpoint and their own approval controls.

## Maintain and verify

```sh
npm run check        # TypeScript, stdlib checks, actual MCP transports, dependency audit
npm run smoke:live   # Actual stdio client; public discovery only, no credentials or writes
```

CI checks Node 22 and 24, then builds the locked container and verifies its HTTP startup. Transport checks use the actual SDK. Workflow checks use isolated responses; they do not demonstrate paid execution, fleet qualification or a production training run. The read-only smoke uses the same default API origin as the connector, accepts an explicit origin override, and does not inherit credentials or activate services.

When the platform changes, verify its deployed customer route, scope and payload first. Update the pinned shared API package for generation or CPU-job contract changes; keep the fixed registry aligned with the reviewed release. Run `npm run check`, the matching platform integration checks, and `npm run smoke:live` before releasing. Test authenticated workflows against an isolated Worker, then perform a separately approved acceptance check on the intended account. Pin a release tag for installation, rebuild after updating, and reconnect the client so it loads the new process.

Generation request builders and JSON response validators come from the version-pinned `@reliquary/api` package, vendored as a release tarball for reproducible installs without a registry credential. Catalog, quote, create, list, detail, cancel and download use the same reviewed contract as the web app. `src/tools.ts` holds the fixed operation registry with strict tool input schemas; `src/api.ts` validates generation envelopes after transport and retains the original retry key when a mutation response is malformed. `src/api.ts` handles fixed-origin requests, credential selection, byte/time/admission bounds, redirect refusal and safe failures. `src/server.ts` registers only the allowed operations and workflow context. `src/http.ts` and `src/index.ts` handle transport and lifecycle. Add a product operation by verifying its customer API contract, adding one schema/builder, and extending the relevant contract check. Keep execution and money decisions in the platform.

Batch files (OpenAI Batch JSONL) use the shared package's file routes and Node helpers. `reliquary_batch_upload` (writes enabled, orders key, local stdio only) uploads a local `.jsonl` in resumable parts after the user confirms data rights and approves; `reliquary_batch_quote` and `reliquary_batch_order` quote and order it on a pinned model; `reliquary_batch_file_get` reads the file record; `reliquary_batch_files` lists a delivery's names, sizes, sha256 and URLs; `reliquary_batch_download` (local stdio only) writes the delivery under a chosen directory with Range resume and sha256 checks. No batch tool returns file contents; an HTTP connector does not register the disk tools because it cannot reach the customer's files.

Evaluations on a customer's file reuse those tools: every line carries a top-level `reference`, and `reliquary_batch_quote` takes an optional `grader` (`boxed_math_v1` or `exact_match_v1`). The quote then shows `purpose: "eval"`, the grader and `pricing.grading_fee_usd`; the shared package refuses a quote whose grader differs from the request. `reliquary_generation_order_get` returns `order.evaluation` (grader, `pending`/`graded`/`ungraded` status, `complete` and the score summary) and `reliquary_batch_files` returns the same summary beside the files of delivery `evaluation` (`graded.parquet`, `report.json`, `manifest.json`). The official skill `reliquary-evaluation-file` describes the workflow. `reliquary_generation_catalog` keeps the catalog's `architectures`, the model architectures quotes accept. The platform's OpenAI-compatible routes (`https://app.reliqua.ai/api/openai/v1`) serve the same files for the official OpenAI SDK; these tools keep using the native routes, which quote before ordering. `reliquary_evaluation_quote` accepts the catalog's namespaced environment ids such as `verifiers:aime25`, which 0.11 refused.

CPU job builders, client and validators use the pinned 0.12.0 shared package. Its transport is injected through the existing connector's credential, disabled-write, redirect, response, timeout and admission controls. Upload receipts are checked against actual input bytes, reports against frozen artifact digests, and mutated responses against their original intent. Unknown outcomes preserve both the original idempotency key and reviewed revision. Existing generation contracts remain unchanged; training uses its separately scoped platform routes.

Protocol references: [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [official SDK](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1), [HTTP serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), [authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html).

### Test reports

CI keeps a unit-test count summary for seven days, including failed runs.
Generated reports stay in ignored `test-results/`; logs, credentials and raw
response bodies are not uploaded. Maintained tests and fixtures remain versioned.

## Affine assisted pilot

The six `reliquary_affine_*` tools expose status, checkpoint review/preparation, preparation detail, frozen evaluation preparation and exact native-request upload through the existing training corridor. See the `/docs/agents/affine-pilot` on the selected origin and `reliquary://workflows`. Select the isolated API origin explicitly and configure separate `training:write` and `resources:write` keys; writes remain disabled by default. Wallet claims and request-window actions stay in the human browser. No cookies, administrator or operator authority is provided.

The finite two-hour coordinator/operator window requires at least 70 minutes remaining before preparation. Eligible checkpoints are public ungated full MiMo-compatible 9B safetensors up to 20 GiB, under fixed four-diagnostic policy `mimo-diagnostic4-v1` and USD 5.10 maximum. Review the resolved revision, policy digest, cost and expiry before explicit preparation approval. Preserve the original UUID `requestId` in both the body and `Idempotency-Key` after an ambiguous result; do not retry automatically.

When ready, prepare the exact native request, upload it after rights confirmation, then save the returned configuration plus `dataset: {id: uploadedFileId}` through `reliquary_resource_create`. The generic training draft builder cannot express the native evaluation method. Use the existing quote, explicitly approved start, task and artifact tools. A signed receipt records frozen execution metadata; check its signature and digests. Diagnostic completion does not establish official Affine acceptance, native parity, rewards, promotion, chain transactions or arbitrary model support.

For an isolated pilot, set `RELIQUARY_API_URL` to the exact pilot origin. Discovery resolves documentation and immutable skill links against that origin. These are configured references, not fetched or verified publication evidence; the default production API continues to use the production documentation origin. Do not use pilot packages or credentials as evidence of production availability.

## Local official batch preparation (0.8 source candidate)

`reliquary_affine_batch_review` and `reliquary_affine_batch_plan` are local read-only tools, available without a training key or write enablement. Each accepts raw `batchJson` and `miningJson` strings up to 1 MiB, plus the intended `hotkey`. The SDK accepts complete batches up to 64 MiB. No paths, credentials, network, upload, process execution or paid endpoint is added. The existing MCP message cap remains unchanged.

Planning adds independent `head`/`reference` descriptor digests, explicit `master` (`provided` or `bf16-bootstrap`), `seed`, `prior` (`provided` or `env-average`), `trainingResultAt` and `lastGreenDecidedAt`. It returns input-bound metadata and placeholder argv for official tokenizer validation, one GRPO step and parent/candidate comparison on a separately selected owned host. Keep generated plans and batch contents private. CPU tiny commands demonstrate plumbing only; full tokenizer checks remain not_run, and qualification, live parity, official acceptance and chain submission are not established.

Use the bundled `reliquary-affine-batches` instructions and [pinned official miner guide](https://github.com/AffineFoundation/affine/blob/a59734f8a7a494c46df47ca3955cc7f594ec6bc0/miner/README.md). This 0.10 package is a private source candidate; no hosted 0.10 publication is asserted. The 0.7 checkpoint diagnostic stays separate and does not implement this batch workflow.
