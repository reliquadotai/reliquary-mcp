import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenApiSpec, parseSpec, pointer, specMediaType } from '../dist/openapi.js';

const SPEC_URL = 'https://api.example/v1/openapi.json';
const size = value => Buffer.byteLength(JSON.stringify(value));
const view = (extra = {}) => ({ specUrl: SPEC_URL, callable: ['https://api.example'], budget: 255 * 1024, ...extra });
const load = (spec, url = SPEC_URL) => new OpenApiSpec(spec, 'json', url, size(spec));
const code = expected => error => error.code === expected;

const PETS = {
  openapi: '3.1.0',
  info: { title: 'Pet\u0000 Store', version: '2', description: 'Pets.\nMore.' },
  servers: [{ url: '/v1', description: 'Same host' }, { url: 'https://{region}.pets.example/v1', variables: { region: { default: 'eu' } } }, { url: 'http://api.example/v1' }],
  security: [{ ApiKey: [] }],
  tags: [{ name: 'pets', description: 'Manage pets.' }],
  paths: {
    '/pets': {
      parameters: [{ name: 'tenant', in: 'header', schema: { type: 'string' } }, { $ref: '#/components/parameters/Limit' }],
      get: { operationId: 'listPets', summary: 'List pets', tags: ['pets'], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } },
      post: { operationId: 'createPet', description: '\n  Create a pet.\nSecond line.', tags: ['pets'], security: [{ ApiKey: [], Signature: [] }, {}],
        requestBody: { $ref: '#/components/requestBodies/NewPet' }, responses: { 201: { $ref: '#/components/responses/Created' }, default: { $ref: '#/components/responses/Error' } } },
    },
    '/pets/{id}': {
      get: { operationId: 'getPet', summary: 'Get a pet', security: [], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      delete: { operationId: 'deletePet', summary: 'Delete a pet', deprecated: true, method: 'GET', path: '/elsewhere', responses: { 204: { description: 'gone' } } },
    },
  },
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    requestBodies: { NewPet: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } }, 'application/x-www-form-urlencoded': { schema: { $ref: '#/components/schemas/NewPet' } } } } },
    responses: {
      Created: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
      Error: { description: 'error', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    schemas: {
      Pet: { allOf: [{ $ref: '#/components/schemas/NewPet' }, { type: 'object', properties: { id: { type: 'string' }, owner: { $ref: '#/components/schemas/Owner' } } }] },
      NewPet: { type: 'object', properties: { name: { type: 'string' }, tag: { $ref: '#/components/schemas/Tag' } } },
      Tag: { type: 'string' },
      Owner: { type: 'object', properties: { pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
      Error: { type: 'object', properties: { code: { type: 'string' } } },
    },
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Key\u0007 from the console.' },
      Signature: { $ref: '#/components/securitySchemes/Sig' }, Sig: { type: 'http', scheme: 'signature', flows: { ignored: true } },
    },
  },
};

test('specs are read as JSON or YAML by content type, and anything else is refused', () => {
  for (const type of ['application/json', 'application/problem+json', 'application/vnd.oai.openapi+json;version=3.0']) assert.equal(specMediaType(type), 'json', type);
  for (const type of ['application/yaml', 'application/x-yaml', 'text/yaml; charset=utf-8', 'text/x-yaml', 'application/vnd.oai.openapi']) assert.equal(specMediaType(type), 'yaml', type);
  for (const type of ['', 'text/plain; charset=utf-8', 'application/octet-stream']) assert.equal(specMediaType(type), 'sniff', type);
  for (const type of ['text/html', 'image/png']) assert.equal(specMediaType(type), undefined, type);
  const limit = 2 * 1024 * 1024;
  assert.deepEqual(parseSpec('\ufeff{"openapi":"3.1.0","paths":{}}', 'json', limit), { spec: { openapi: '3.1.0', paths: {} }, format: 'json' });
  const yaml = parseSpec('openapi: 3.1.0\npaths:\n  /a:\n    get:\n      responses:\n        200: { description: ok }\n', 'yaml', limit);
  assert.equal(yaml.format, 'yaml');
  assert.deepEqual(yaml.spec.paths['/a'].get.responses, { 200: { description: 'ok' } });
  assert.equal(parseSpec('{"openapi":"3.0.0","paths":{}}', 'sniff', limit).format, 'json');
  assert.equal(parseSpec('openapi: 3.0.0\npaths: {}\n', 'sniff', limit).format, 'yaml');
  assert.equal(parseSpec('{ openapi: 3.0.0, paths: {} }', 'sniff', limit).format, 'yaml', 'a YAML flow mapping is not JSON');
  for (const [text, media] of [['{', 'json'], ['{ openapi: 3.0.0, paths: {} }', 'json'], ['[]', 'json'], ['"text"', 'sniff'], ['{"openapi":"3.0.0"}', 'json'],
    ['{"openapi":"3.0.0","paths":[]}', 'json'], ['openapi: 3.0.0\npaths: {}\n---\nopenapi: 3.0.0\n', 'yaml'], ['a: [b', 'yaml'], ['', 'yaml']]) {
    assert.throws(() => parseSpec(text, media, limit), code('not_openapi'), text);
  }
  const deep = '['.repeat(200) + ']'.repeat(200);
  assert.throws(() => parseSpec(`{"openapi":"3.0.0","paths":{},"x":${deep}}`, 'json', limit), code('not_openapi'));
  assert.throws(() => parseSpec(`openapi: 3.0.0\npaths: {}\nx: ${deep}\n`, 'yaml', limit), code('not_openapi'));
});

test('YAML specs are plain data: no alias bombs or cycles, merge keys, language tags or prototype keys', () => {
  const head = 'openapi: 3.1.0\npaths: {}\n';
  const limit = 2 * 1024 * 1024;
  const levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]', ...'bcde'.split('').map((name, i) => `${name}: &${name} [${Array(9).fill('*' + 'abcd'[i]).join(',')}]`)];
  assert.throws(() => parseSpec(head + levels.join('\n') + '\n', 'yaml', limit), code('not_openapi'), 'too many aliases');
  assert.throws(() => parseSpec(head + 'x: &a [ *a ]\n', 'yaml', limit), code('not_openapi'), 'an alias inside its own anchor');
  assert.throws(() => parseSpec(head + `a: &a "${'x'.repeat(300)}"\nb: [*a, *a, *a, *a, *a, *a, *a, *a]\n`, 'yaml', 2000), code('response_too_large'), 'aliases expanded past the limit');
  const { spec } = parseSpec('%YAML 1.1\n---\n' + head + 'base: &base { k: 1 }\nm: { <<: *base, own: yes, when: 2001-12-14 }\nbin: !!binary aGVsbG8=\nfn: !js/function "x"\n' +
    '__proto__: { polluted: true }\ninfo: { title: a, title: b }\n', 'yaml', limit);
  assert.deepEqual(spec.m, { '<<': { k: 1 }, own: 'yes', when: '2001-12-14' });
  assert.deepEqual([spec.bin, spec.fn, spec.info.title], ['aGVsbG8=', 'x', 'b']);
  assert.ok(Object.hasOwn(spec, '__proto__'));
  assert.equal(Object.getPrototypeOf(spec), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('local refs follow JSON Pointer with fragment encoding, own properties only', () => {
  assert.equal(pointer(PETS, '#/paths/~1pets~1%7Bid%7D/get/operationId'), 'getPet');
  assert.equal(pointer({ 'a~b': { 'c/d': 1 } }, '#/a~0b/c~1d'), 1);
  assert.equal(pointer({ list: ['x', 'y'] }, '#/list/1'), 'y');
  assert.equal(pointer(PETS, '#'), PETS);
  for (const ref of ['#/components/schemas/Nope', '#/constructor', '#/components/schemas/toString', '#/servers/01', '#/servers/9', '#/servers/-1', '#/a%ZZ', 'other.json#/x', '#components']) {
    assert.equal(pointer(PETS, ref), undefined, ref);
  }
});

test('the index lists every operation compactly with inherited security, referenced content types and spec info', () => {
  const index = load(PETS).index(view());
  assert.deepEqual(index.info, {
    title: 'Pet Store', version: '2', openapi: '3.1.0', description: 'Pets. More.',
    servers: [{ url: 'https://api.example/v1', callable: true, description: 'Same host' }, { url: 'https://eu.pets.example/v1', callable: false },
      { url: 'http://api.example/v1', callable: false }],
    securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Key from the console.' },
      Signature: { type: 'http', scheme: 'signature' }, Sig: { type: 'http', scheme: 'signature' } },
    security: ['ApiKey'], tags: [{ name: 'pets', count: 2, description: 'Manage pets.' }],
  });
  assert.deepEqual([index.total, index.matched, index.offset, index.count, index.nextOffset], [4, 4, 0, 4, undefined]);
  assert.deepEqual(index.operations, [
    { method: 'GET', path: '/pets', operationId: 'listPets', summary: 'List pets', tags: ['pets'], security: ['ApiKey'], responseTypes: ['application/json'] },
    { method: 'POST', path: '/pets', operationId: 'createPet', summary: 'Create a pet.', tags: ['pets'], security: ['ApiKey+Signature', 'none'],
      requestTypes: ['application/json', 'application/x-www-form-urlencoded'], responseTypes: ['application/json', 'application/problem+json'] },
    { method: 'GET', path: '/pets/{id}', operationId: 'getPet', summary: 'Get a pet', security: ['none'], responseTypes: ['application/json'] },
    { method: 'DELETE', path: '/pets/{id}', operationId: 'deletePet', summary: 'Delete a pet', security: ['ApiKey'], deprecated: true },
  ]);
  assert.match(index.hint, /operationId/);
  assert.deepEqual(load({ openapi: '3.0.0', paths: {} }).index(view()).info.servers, [{ url: 'https://api.example/', callable: true }], 'no servers: the spec host');
});

test('the index filters by query words and pages by offset, limit and the byte budget', () => {
  const pets = load(PETS);
  assert.deepEqual(pets.index(view({ query: 'pet CREATE' })).operations.map(o => o.operationId), ['createPet']);
  assert.deepEqual(pets.index(view({ query: 'pets {id}' })).operations.map(o => o.operationId), ['getPet', 'deletePet']);
  const first = pets.index(view({ limit: 1 }));
  assert.deepEqual([first.count, first.nextOffset, first.operations[0].operationId, 'info' in first], [1, 1, 'listPets', true]);
  const last = pets.index(view({ offset: 3, limit: 1 }));
  assert.deepEqual([last.count, last.nextOffset, last.operations[0].operationId, 'info' in last], [1, undefined, 'deletePet', false]);
  const past = pets.index(view({ offset: 10 }));
  assert.deepEqual([past.count, past.operations, past.hint], [0, [], undefined]);

  const paths = {};
  for (let i = 0; i < 300; i++) paths[`/things/${i}`] = { get: { operationId: `thing${i}`, summary: `${'\u0001'.repeat(5)}Thing ${i} ${'s'.repeat(400)}`, responses: {} } };
  const many = load({ openapi: '3.1.0', paths });
  assert.equal(many.index(view({ limit: 1 })).operations[0].summary.length, 200, 'summaries are capped');
  const seen = [];
  for (let offset = 0, pages = 0; offset !== undefined; pages++) {
    const page = many.index(view({ offset, limit: 500, budget: 20 * 1024 }));
    assert.ok(size(page) <= 20 * 1024, `page at ${offset} is ${size(page)} bytes`);
    assert.ok(page.count < 100);
    seen.push(...page.operations.map(o => o.operationId));
    offset = page.nextOffset;
    assert.ok(pages < 100);
  }
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => `thing${i}`));
  assert.throws(() => many.index(view({ offset: 1, budget: 600 })), code('index_too_large'));
});

test('an operation comes with merged parameters, effective security and each component it reaches once', () => {
  const pets = load(PETS);
  const created = pets.operation(view({ operationId: 'createPet', depth: 8 }));
  assert.deepEqual(created.servers.map(s => s.url), ['https://api.example/v1', 'https://eu.pets.example/v1', 'http://api.example/v1']);
  assert.equal(created.operation.method, 'POST');
  assert.equal(created.operation.path, '/pets');
  assert.deepEqual(created.operation.parameters, PETS.paths['/pets'].parameters);
  assert.deepEqual(created.operation.security, [{ ApiKey: [], Signature: [] }, {}]);
  assert.deepEqual(Object.keys(created.securitySchemes), ['ApiKey', 'Signature']);
  assert.deepEqual(Object.keys(created.components), ['#/components/requestBodies/NewPet', '#/components/responses/Created', '#/components/responses/Error',
    '#/components/parameters/Limit', '#/components/schemas/NewPet', '#/components/schemas/Pet', '#/components/schemas/Error', '#/components/schemas/Tag', '#/components/schemas/Owner']);
  assert.deepEqual(created.components['#/components/schemas/Owner'], PETS.components.schemas.Owner, 'components are the published values, refs kept');
  assert.equal(created.unresolved, undefined);

  const listed = pets.operation(view({ method: 'GET', path: '/pets', depth: 8 }));
  assert.deepEqual(listed.operation.parameters, [PETS.paths['/pets'].parameters[0], PETS.paths['/pets'].get.parameters[0]], 'the operation\'s limit replaces the path\'s');
  assert.deepEqual(listed.operation.security, [{ ApiKey: [] }], 'inherited from the spec');
  assert.deepEqual(Object.keys(listed.securitySchemes), ['ApiKey']);
  assert.deepEqual(pets.operation(view({ operationId: 'getPet', depth: 8 })), pets.operation(view({ method: 'GET', path: '/pets/{id}', depth: 8 })));
  const deleted = pets.operation(view({ operationId: 'deletePet', depth: 8 }));
  assert.deepEqual([deleted.operation.method, deleted.operation.path], ['DELETE', '/pets/{id}'], 'published method and path fields do not override');

  const shallow = pets.operation(view({ operationId: 'createPet', depth: 2 }));
  assert.equal(Object.keys(shallow.components).length, 7);
  assert.deepEqual(shallow.unresolved, [{ ref: '#/components/schemas/Tag', reason: 'depth' }, { ref: '#/components/schemas/Owner', reason: 'depth' }]);
  assert.equal(shallow.unresolvedCount, 2);
  const none = pets.operation(view({ operationId: 'createPet', depth: 0 }));
  assert.deepEqual([Object.keys(none.components).length, none.unresolvedCount], [0, 4]);
  assert.equal(pets.operation(view({ operationId: 'nope', depth: 8 })), undefined);
  assert.equal(pets.operation(view({ method: 'PUT', path: '/pets', depth: 8 })), undefined);
});

test('a ref is read with the components it reaches, and refs that cannot be bundled say why', () => {
  const pets = load(PETS);
  const pet = pets.ref(view({ ref: '#/components/schemas/Pet', depth: 8 }));
  assert.deepEqual(pet.value, PETS.components.schemas.Pet);
  assert.deepEqual(Object.keys(pet.components), ['#/components/schemas/NewPet', '#/components/schemas/Owner', '#/components/schemas/Tag'], 'the ref itself is not repeated');
  assert.equal(pets.ref(view({ ref: '#/components/schemas/Nope', depth: 8 })), undefined);

  const edges = load({ openapi: '3.0.3', paths: { '/x': { get: { operationId: 'x', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { oneOf: [
    { $ref: '#/components/schemas/Gone' }, { $ref: 'https://elsewhere.example/schemas.json#/Thing' }, { $ref: '#/components/schemas/A~1B' },
    { $ref: '#/components/schemas/Spaced%20Name' }, { $ref: '#/components/schemas/Big' }, { $ref: '#/components/schemas/After' }] } } } } } } } },
  components: { schemas: { 'A/B': { type: 'string' }, 'Spaced Name': { type: 'number' }, Big: { type: 'string', description: 'x'.repeat(40_000) }, After: { type: 'boolean' } } } });
  const all = edges.operation(view({ operationId: 'x', depth: 8 }));
  assert.deepEqual(Object.keys(all.components), ['#/components/schemas/A~1B', '#/components/schemas/Spaced%20Name', '#/components/schemas/Big', '#/components/schemas/After']);
  assert.deepEqual(all.unresolved, [{ ref: '#/components/schemas/Gone', reason: 'missing' }, { ref: 'https://elsewhere.example/schemas.json#/Thing', reason: 'external' }]);
  const cut = edges.operation(view({ operationId: 'x', depth: 8, budget: 30 * 1024 }));
  assert.ok(size(cut) <= 30 * 1024, `${size(cut)} bytes`);
  assert.equal(cut.truncated, true);
  assert.deepEqual(Object.keys(cut.components), ['#/components/schemas/A~1B', '#/components/schemas/Spaced%20Name']);
  assert.deepEqual(cut.unresolved.slice(2), [{ ref: '#/components/schemas/Big', reason: 'size' }, { ref: '#/components/schemas/After', reason: 'size' }]);
  assert.throws(() => edges.operation(view({ operationId: 'x', depth: 8, budget: 10 * 1024 })), code('operation_too_large'));
  assert.throws(() => edges.ref(view({ ref: '#/components/schemas/Big', depth: 8, budget: 30 * 1024 })), code('ref_too_large'));
});

test('a ref graph that would explode when inlined is bundled once per target, within the depth', () => {
  const schemas = { S40: { type: 'string' } };
  for (let i = 0; i < 40; i++) schemas[`S${i}`] = { type: 'object', properties: { left: { $ref: `#/components/schemas/S${i + 1}` }, right: { $ref: `#/components/schemas/S${i + 1}` } } };
  const fan = load({ openapi: '3.1.0', paths: { '/f': { post: { operationId: 'f', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: {} } } },
    components: { schemas } });
  const started = performance.now();
  const answer = fan.operation(view({ operationId: 'f', depth: 16 }));
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(Object.keys(answer.components), Array.from({ length: 16 }, (_, i) => `#/components/schemas/S${i}`));
  assert.deepEqual(answer.unresolved, [{ ref: '#/components/schemas/S16', reason: 'depth' }]);
  assert.ok(size(answer) < 8 * 1024);
});

test('Swagger 2.0 specs give servers, content types and security from their own fields', () => {
  const swagger = load({
    swagger: '2.0', info: { title: 'Files', version: '1' }, host: 'files.example', basePath: '/api', schemes: ['https', 'http'],
    consumes: ['application/json'], produces: ['application/json'],
    securityDefinitions: { Bearer: { type: 'apiKey', in: 'header', name: 'Authorization' } }, security: [{ Bearer: [] }],
    parameters: { Body: { name: 'body', in: 'body', schema: { $ref: '#/definitions/File' } } },
    paths: { '/files': {
      post: { operationId: 'upload', consumes: ['multipart/form-data'], parameters: [{ name: 'file', in: 'formData', type: 'file' }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/File' } } } },
      put: { operationId: 'replace', parameters: [{ $ref: '#/parameters/Body' }], responses: { 200: { description: 'ok' } } },
      get: { operationId: 'list', produces: ['text/csv'], responses: { 200: { description: 'ok' } } },
    } },
    definitions: { File: { type: 'object', properties: { id: { type: 'string' } } } },
  }, 'https://files.example/swagger.json');
  const index = swagger.index(view({ specUrl: 'https://files.example/swagger.json', callable: ['https://files.example'] }));
  assert.equal(index.info.swagger, '2.0');
  assert.deepEqual(index.info.servers, [{ url: 'https://files.example/api', callable: true }, { url: 'http://files.example/api', callable: false }]);
  assert.deepEqual(index.info.securitySchemes, { Bearer: { type: 'apiKey', in: 'header', name: 'Authorization' } });
  assert.deepEqual(index.operations.map(o => [o.operationId, o.requestTypes, o.responseTypes, o.security]), [
    ['list', undefined, ['text/csv'], ['Bearer']], ['replace', ['application/json'], ['application/json'], ['Bearer']],
    ['upload', ['multipart/form-data'], ['application/json'], ['Bearer']]]);
  const replace = swagger.operation(view({ specUrl: 'https://files.example/swagger.json', operationId: 'replace', depth: 8 }));
  assert.deepEqual([replace.operation.consumes, replace.operation.produces], [['application/json'], ['application/json']]);
  assert.deepEqual(Object.keys(replace.components), ['#/parameters/Body', '#/definitions/File']);
  assert.deepEqual(load({ swagger: '2.0', paths: {} }, 'https://docs.example/swagger.json').index(view({ specUrl: 'https://docs.example/swagger.json' })).info.servers,
    [{ url: 'https://docs.example/', callable: false }], 'no host: the spec host');
});

test('prototype keys in a spec stay ordinary data', () => {
  const spec = JSON.parse('{"openapi":"3.1.0","security":[{"__proto__":[]}],"paths":{"/a":{"get":{"operationId":"a","responses":{"200":{"description":"ok","content":' +
    '{"application/json":{"schema":{"$ref":"#/components/schemas/__proto__"}}}}}}}},"components":{"schemas":{"__proto__":{"type":"string","polluted":true}},' +
    '"securitySchemes":{"__proto__":{"type":"http","scheme":"bearer"}}}}');
  const parsed = load(spec);
  const index = parsed.index(view());
  assert.ok(Object.hasOwn(index.info.securitySchemes, '__proto__'));
  assert.deepEqual(index.operations[0].security, ['__proto__']);
  const answer = parsed.operation(view({ operationId: 'a', depth: 8 }));
  assert.deepEqual(answer.components['#/components/schemas/__proto__'], { type: 'string', polluted: true });
  assert.ok(Object.hasOwn(answer.securitySchemes, '__proto__'));
  assert.equal({}.polluted, undefined);
  assert.equal({}.type, undefined);
});
