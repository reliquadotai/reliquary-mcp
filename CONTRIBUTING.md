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

Publication requires separate authorization and an existing npm maintainer session with control of `@reliquadotai`. GitHub repository access does not establish npm scope ownership. Publish only the reviewed tarball, following [npm's publishing documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/):

```sh
# Authorized release only; use the filename emitted by npm pack.
npm publish ./reliquadotai-mcp-0.12.1.tgz --access public
npm view @reliquadotai/mcp@0.12.1 dist.integrity dist.tarball
```

Verify a fresh installation of that exact public version and its reported runtime, read-only tools and skill catalog before publishing Registry metadata. Preserve npm integrity and installation evidence; a successful local pack is not evidence of npm publication.

For `io.github.reliquadotai/reliquary-mcp`, verify namespace authority for the selected authentication route. Personal GitHub authentication requires an active organization Owner membership; the [Registry authentication guide](https://modelcontextprotocol.io/registry/authentication) documents the current limitation of interactive `login github` for organization namespaces. An existing approved PAT needs organization membership read access. [GitHub Actions OIDC](https://modelcontextprotocol.io/registry/github-actions) instead derives the namespace from the signed repository-owner claim; repository workflow authority and the personal Owner role are distinct. A proposed publishing workflow needs separate authorization for activating its identity permissions and publication steps. Do not create tokens or persistent trust as part of preparation. Once authorized and authenticated against the intended Registry, run `mcp-publisher validate server.json`, then `mcp-publisher publish server.json`. Confirm the exact version through the [Registry API](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.reliquadotai%2Freliquary-mcp/versions/0.12.1) and retain its receipt before claiming a listing. The Registry stores metadata; the npm package must be available first.
