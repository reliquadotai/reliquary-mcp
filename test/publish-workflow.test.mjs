import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Full-line YAML and shell comments are dropped, so a commented-out guard cannot satisfy a match.
const text = (await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'))
  .replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^[ \t]*#.*\n/gm, '');
const block = (name, indent) => {
  const start = text.indexOf(`\n${' '.repeat(indent)}${name}:`);
  assert.notEqual(start, -1, name);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(new RegExp(`\\n {0,${indent}}[^ \\n]`));
  return next === -1 ? rest : rest.slice(0, next + 2);
};

test('the publish workflow runs only on request and stores no npm token', () => {
  assert.deepEqual([...block('on', 0).matchAll(/^ {2}(\S[^:]*):/gm)].map(match => match[1]), ['workflow_dispatch']);
  assert.match(text, /^permissions: \{\}$/m);
  assert.doesNotMatch(text, /\bsecrets\b|NPM_TOKEN|NODE_AUTH_TOKEN|write-all/);
  const uses = [...text.matchAll(/^ *(?:- )?uses:(.*)$/gm)].map(match => match[1]);
  assert.ok(uses.length >= 4);
  for (const ref of uses) assert.match(ref, /^ [\w.-]+\/[\w./-]+@[0-9a-f]{40}( #.*)?$/);
});

test('the build job checks the environment, the Verification run and the reviewed tarball', () => {
  const build = block('build', 2);
  assert.match(build, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.doesNotMatch(build, /id-token|environment:/);
  assert.match(build, /environments\/npm" --jq '\.deployment_branch_policy/);
  assert.match(build, /^ {10}\[ "\$policy" = "false true" \] \|\|/m);
  assert.match(build, /^ {10}\[ "\$rules" = "branch:main" \] \|\|/m);
  assert.match(build, /--workflow ci\.yml --event push --commit "\$GITHUB_SHA" --status success/);
  assert.match(build, /^ {10}\[ "\$runs" -ge 1 \] \|\|/m);
  assert.match(build, /^ {10}persist-credentials: false$/m);
  assert.match(build, /^ {10}node-version: '24\.21\.0'$/m);
  assert.match(build, /^ {6}- run: npm run check$/m);
  assert.match(build, /^ {10}\[ "\$actual" = "\$EXPECTED_SHA256" \] \|\|/m);
});

test('only the publish job can request the npm identity, and it runs only the npm CLI', () => {
  const publish = block('publish', 2);
  assert.equal(text.match(/id-token:/g).length, 1);
  assert.match(publish, /^ {6}id-token: write$/m);
  assert.match(publish, /^ {4}environment: npm$/m);
  assert.match(publish, /^ {4}needs: build$/m);
  assert.match(publish, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(publish, /^ {10}node-version: '24\.21\.0'$/m);
  assert.deepEqual([...publish.matchAll(/uses: ([\w./-]+)@/g)].map(match => match[1]), ['actions/setup-node', 'actions/download-artifact']);
  const code = publish.replace(/^\s*(- )?name:.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.doesNotMatch(code, /\bnpx\b|actions\/checkout/);
  assert.deepEqual([...new Set([...code.matchAll(/\bnpm(?: -\S+)* ([a-z][\w-]*)/g)].map(match => match[1]))].sort(), ['publish', 'stage', 'view']);
  assert.match(publish, /^ {10}echo "\$EXPECTED_SHA256  \$tarball" \| sha256sum --check --strict$/m);
  assert.match(publish, /npm stage publish "\$TARBALL"/);
});
