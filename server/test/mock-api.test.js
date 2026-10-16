import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../src/app.js';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = null;
    this.body = null;
    this.finished = new Promise((resolve) => { this.resolve = resolve; });
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value;
  }
  end(body) { this.body = body; this.emit('finish'); this.resolve(); }
}

const metrics = { renderPrometheus: () => 'metrics' };
const soroban = {
  pingAllContracts: async () => ({ credential: true }),
  circuitBreaker: { toHealthInfo: () => ({ state: 'CLOSED', failures: 0, lastStateChange: '' }) },
  getIssuers: async () => [],
  addIssuer: async () => {},
};
const baseConfig = {
  dataDir: '/tmp/soroban-identity-mock-api-test',
  auditLogPath: '/tmp/soroban-identity-mock-api-test/audit.ndjson',
  credentialStorePath: '/tmp/soroban-identity-mock-api-test/credentials.json',
  maxBodyBytes: 4096,
  mockApiEnabled: true,
  nodeEnv: 'development',
};

async function callApp({ path, method = 'GET', body, config = baseConfig }) {
  const app = createApp({ config: { ...baseConfig, ...config }, soroban, metrics });
  const req = {
    method,
    url: path,
    headers: { host: 'localhost', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }),
  };
  const res = new MockResponse();
  await app(req, res);
  await res.finished;
  return { res, json: JSON.parse(res.body) };
}

test('serves deterministic mock API health, credential, DID, and reputation fixtures', async () => {
  const health = await callApp({ path: '/mock/v1/health' });
  assert.equal(health.res.statusCode, 200);
  assert.deepEqual(health.json, { status: 'ok', mock: true });
  assert.equal(health.res.headers['cache-control'], 'no-store');
  assert.equal(health.res.headers['x-request-id'], health.res.headers['x-correlation-id']);

  const list = await callApp({ path: '/mock/v1/credentials' });
  assert.equal(list.json.count, 1);
  assert.equal(list.json.items[0].id, 'mock-credential-001');

  const did = await callApp({ path: '/mock/v1/dids/GMOCKADDRESS12345678' });
  assert.equal(did.json.document.id, 'did:stellar:GMOCKADDRESS12345678');

  const reputation = await callApp({ path: '/mock/v1/reputation/GMOCKADDRESS12345678' });
  assert.equal(reputation.json.score, 72);
});

test('mock credential creation returns an in-memory fixture without persisting data', async () => {
  await fs.rm(baseConfig.credentialStorePath, { force: true });
  const result = await callApp({
    path: '/mock/v1/credentials',
    method: 'POST',
    body: { subject: 'GMOCKSUBJECT', credentialType: 'Kyc', claims: { name: 'Test' } },
  });
  assert.equal(result.res.statusCode, 201);
  assert.equal(result.json.credential.id, 'mock-created-credential');
  assert.equal(result.json.credential.mock, true);
  await assert.rejects(fs.access(baseConfig.credentialStorePath), { code: 'ENOENT' });
});

test('mock routes are hidden unless explicitly enabled and are always disabled in production', async () => {
  const disabled = await callApp({ path: '/mock/v1/health', config: { mockApiEnabled: false } });
  assert.equal(disabled.res.statusCode, 404);
  assert.equal(disabled.json.error, 'not_found');

  const production = await callApp({ path: '/mock/v1/health', config: { nodeEnv: 'production' } });
  assert.equal(production.res.statusCode, 404);
});
