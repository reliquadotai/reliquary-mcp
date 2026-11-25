# Contributing

Fork the repository, create a focused branch and open a pull request. Describe the behavior changed and the checks you ran. Maintainers review changes before merging into `main`.

Use Node.js 22 or later and run:

```sh
npm ci
npm run check
```

Tests use synthetic data and local fixtures. Keep credentials, customer data, operational details and investigation evidence out of commits, issues, pull requests and test logs. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

The source is MIT licensed. Submit only work you have permission to contribute under that license. Package publication and hosted deployment are separate maintainer decisions.

## Maintainer release handoff

Keep `package.json`, `package-lock.json`, the runtime version and `server.json` aligned. The API tarball and skill catalog have their own version; update them only when their reviewed contracts change. Retain the working preview installation and rollback instructions until the npm release is publicly installable.

Prepare from the exact reviewed commit on Node 22 or 24:

```sh
npm ci
npm run check
npm pack
mcp-publisher validate server.json
```

Use a reviewed, separately installed `mcp-publisher`; its [command reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md) defines validation and publication. Validation does not publish. Record the source commit, Node/npm versions, checks, tarball SHA-256 and packed file list. The package test installs into a temporary prefix with a fresh offline cache and launches its actual executable; also retain the CI container result and run the credential-free public smoke before release.

Publication requires separate authorization. GitHub repository access does not establish npm scope ownership. Publish only the reviewed tarball, following [npm's publishing documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/). The first version creates the package on npm, so a maintainer publishes it from an npm session with control of `@reliquadotai`; `npm login` and `npm publish` open the browser for the account's two-factor authentication:

```sh
# Authorized release only; use the filename emitted by npm pack.
npm publish ./reliquadotai-mcp-0.13.0.tgz --access public
npm view @reliquadotai/mcp@0.13.0 dist.integrity dist.tarball
```

Later versions go through the [Publish workflow](.github/workflows/publish.yml) with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): no long-lived npm token is stored. The job that requests the npm identity exchanges it for a short-lived npm token, so it checks out nothing and runs no package or dependency code. The workflow runs from `main` only, after a successful push Verification run on the same commit, and refuses a tarball whose SHA-256 differs from the reviewed one. Activating it is a separate maintainer decision, made in this order:

1. In the repository settings, create the `npm` environment, or open it if a workflow run already created it without rules, and set its deployment branches to the single branch `main`. npm checks the repository, the workflow file and the environment, never the branch, so this rule is what keeps a modified copy of the workflow on another branch away from npm; the workflow refuses to run without it. Add required reviewers if each run should wait for one; a run left unapproved for 30 days fails and must be dispatched again.
2. When a release is ready, register the workflow as a trusted publisher of the package: GitHub Actions, organization `reliquadotai`, repository `reliquary-mcp`, workflow `publish.yml`, environment `npm`. The CLI equivalent, with npm 11.15.0 or later and a 2FA check, is `npm trust github @reliquadotai/mcp --repo reliquadotai/reliquary-mcp --file publish.yml --env npm --allow-stage-publish`. New configurations allow staging only. Allowing `npm publish` as well lets any account or token that can dispatch workflows in this repository publish `main` without a 2FA step; required reviewers with Prevent self-review on the `npm` environment keep a second person in that path.
3. Run the workflow straight away: npm expires a new configuration that has not completed a release within 48 hours.
4. Once a release has gone through the workflow, set the package's publishing access to require two-factor authentication and disallow tokens.

To release, run the workflow on `main` with the version, the SHA-256 of the reviewed tarball packed with an official Node.js 24.21.0 build (nodejs.org or nvm; builds that use the system zlib, such as Homebrew's, pack different bytes) and a mode, for example `gh workflow run publish.yml --ref main -f version=0.12.2 -f tarball_sha256=<sha256> -f mode=stage`. npm scans each new version before it can be installed, which usually takes a few minutes. A staged version stays private until a maintainer approves it with 2FA, once the scan has finished, under Staged Packages on npmjs.com or with `npm stage approve <stage-id>`.

Verify a fresh installation of that exact public version and its reported runtime, read-only tools and skill catalog before publishing Registry metadata. Preserve npm integrity and installation evidence; a successful local pack is not evidence of npm publication.

For `io.github.reliquadotai/reliquary-mcp`, verify namespace authority for the selected authentication route. Personal GitHub authentication requires an active organization Owner membership; the [Registry authentication guide](https://modelcontextprotocol.io/registry/authentication) documents the current limitation of interactive `login github` for organization namespaces. An existing approved PAT needs organization membership read access. [GitHub Actions OIDC](https://modelcontextprotocol.io/registry/github-actions) instead derives the namespace from the signed repository-owner claim; repository workflow authority and the personal Owner role are distinct. A proposed publishing workflow needs separate authorization for activating its identity permissions and publication steps. Do not create tokens or persistent trust as part of preparation. Once authorized and authenticated against the intended Registry, run `mcp-publisher validate server.json`, then `mcp-publisher publish server.json`. Confirm the exact version through the [Registry API](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.reliquadotai%2Freliquary-mcp/versions/0.13.0) and retain its receipt before claiming a listing. The Registry stores metadata; the npm package must be available first.
