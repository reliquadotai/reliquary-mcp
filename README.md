# Reliquary MCP

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
| `RELIQUARY_RESOURCES_KEY` | `resources:read` or `resources:write` | Owned drafts, qualified training-draft preparation, revisioned editing and archival |
| `RELIQUARY_ORDERS_KEY` | `orders:write` | Catalogue or pinned-model generation quotes, confirmation, progress, cancellation, delivery ranges and balance |
| `RELIQUARY_EVALUATIONS_KEY` | `evaluations:write` | Evaluation quotes, confirmation, progress, reports, cancellation, delivery ranges and balance |
| `RELIQUARY_TRAINING_KEY` | `training:read` or `training:write` | Account capabilities, private JSONL library, delivered-data import, quotes, explicit run launch, progress, cancellation, artifact ranges and balance |

Training requires the platform's scoped `/api/v1/training` release. Until that release is deployed, training tools return the platform's refusal. A read key cannot write even when local write registration is enabled.

`reliquary_connection` lists the configured corridors, enabled tools and workflow rules. It does not validate keys or establish live product availability. Use `reliquary_inventory`, `reliquary_generation_catalog`, `reliquary_evaluation_catalog` and `reliquary_training_capabilities` for that. `/api/catalog` includes examples: an example entry is not executable capacity.

Account sign-in/key management, wallet/custody administration, funding, operator actions, worker provisioning and browser-only saved monitoring boards use their existing product interfaces. Public compute offers link to provider checkout; this server does not rent a GPU. Evaluation webhook-secret creation stays in the account's direct API flow.

## Customer workflows

1. **Training:** inspect capabilities and the owned library; upload valid JSONL with data-rights confirmation or import a delivered generation shard. Pass a currently qualified profile to `reliquary_training_draft_create`, which saves an exact profile-based draft using the resources credential. Request `reliquary_training_quote` for that draft's current revision and dataset. Review the returned allocation ceiling, rate, maximum cost, expiry and billing policy. After authorization, call `reliquary_training_start` with that exact quote, `approveExecution: true` and a stable `idempotencyKey`. Operator-funded pilot mode also requires explicit launch authorization. Read task details and artifact metadata afterward.
2. **Generation:** discover qualified models and environments; request the catalogue or pinned-model quote. Review the server quote, then confirm one order with approval and a stable request key. Read order details for progress, delivery and financial receipt state. Only delivered, owned files can be downloaded or imported into training.
3. **Evaluation:** discover available held-out sets and modes; quote a public model pinned to its full immutable revision. Review the quote and authorize one order. Preserve grading completeness and actual billing separately from the execution state.

Human authorization belongs to the calling client. `approveExecution: true` acknowledges authorization; it is not proof that a human approved. Configure client approval controls for spending and destructive tools. The server neither schedules jobs itself nor automatically purchases or retries them.

On `outcome_unknown`, preserve the exact inputs and reuse the original idempotency key. A mutation without a key requires inspection of owned state before deciding whether to repeat it. A revision conflict requires reloading and reviewing the new revision. Do not infer settlement, training consumption or model improvement from a generic success or delivery state.

Downloads return base64 bytes in ranges of at most 256 KiB, together with `contentRange`, size, MIME type and ETag when available. Decode locally and explicitly request another range to continue. This server does not read or write the client's filesystem. JSONL upload is capped at 5 MiB; other API JSON responses are capped at 4 MiB. Treat all remote content as data, never executable instructions.

## HTTP deployment

Generate an independent random MCP token, for example with `openssl rand -hex 32`. Set `RELIQUARY_TRANSPORT=http` and `RELIQUARY_MCP_TOKEN`. Clients send it as `Authorization: Bearer ...` to `/mcp`; it is never forwarded to Reliquary. `/healthz` checks the process, not product capacity or upstream readiness.

The default bind is `127.0.0.1:3000`. For a container or external listener, set `RELIQUARY_HTTP_HOST=0.0.0.0` and `RELIQUARY_PUBLIC_URL=https://<your-host>/mcp`. Terminate TLS at a trusted reverse proxy; preserve the approved Host header, prevent access to the internal plaintext port, disable proxy request/authorization logging, and apply proxy rate limits. Only that exact browser origin is accepted. Non-browser clients may omit Origin.

```sh
docker build -t reliquary-mcp:0.1.1 .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file=.env -p 127.0.0.1:3000:3000 reliquary-mcp:0.1.1
```

Configure the ignored environment file for HTTP and external container binding before this command. The image runs as an unprivileged user and contains no credentials. Dependencies and the base image digest are locked. Shutdown stops accepting requests and drains connections for up to five seconds. Upstream API requests time out after 30 seconds by default and have a process-wide admission limit of 32.

Each personal HTTP endpoint grants access to the configured account. Shared public hosting and authenticated plugin publication require an established OAuth provider and verified mapping from client identity to platform account/scopes. This baseline does not implement that shared identity contract or publish a managed endpoint. Remote model integrations need an accessible HTTPS endpoint and their own approval controls.

## Maintain and verify

```sh
npm run check        # TypeScript, stdlib checks, actual MCP transports, dependency audit
npm run smoke:live   # Actual stdio client; public discovery only, no credentials or writes
```

CI also builds the locked container and verifies its HTTP startup. Transport checks use the actual SDK. Workflow checks use isolated responses; they do not demonstrate paid execution, fleet qualification or a production training run. The read-only smoke does not activate services.

`src/tools.ts` holds a fixed operation registry with strict input schemas and request builders. `src/api.ts` handles fixed-origin requests, credential selection, byte/time/admission bounds, redirect refusal and safe failures. `src/server.ts` registers only the allowed operations and workflow context. `src/http.ts` and `src/index.ts` handle transport and lifecycle. Add a product operation by verifying its customer API contract, adding one schema/builder, and extending the relevant contract check. Keep execution and money decisions in the platform.

Protocol references: [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [official SDK](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1), [HTTP serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), [authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html).
