import { URL } from 'node:url';
import { readJson, sendJson } from './http-utils.js';

const PREFIX = '/mock/v1';
const MOCK_CREDENTIALS = [
  {
    id: 'mock-credential-001',
    subject: 'GMOCKSUBJECT000000000000000000000000000000000000000000000000000',
    issuer: 'GMOCKISSUER000000000000000000000000000000000000000000000000000',
    credentialType: 'Kyc',
    claims: { name: 'Ada Example', country: 'US' },
    issuedAt: 1_700_000_000,
    expiresAt: 1_893_456_000,
    revoked: false,
    mock: true,
  },
];

function respond(res, status, body) {
  sendJson(res, status, body, { 'cache-control': 'no-store' });
  return true;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Serve deterministic fixtures for client development without contacting the
 * chain or writing credential data. Mock routes are opt-in and production is
 * always denied, even if the environment variable is accidentally set.
 *
 * @returns {Promise<boolean>} true when a /mock/v1 request was handled.
 */
export async function handleMockApiRequest(req, res, config = {}) {
  const url = new URL(req.url ?? '/', `http://${req.headers?.host ?? 'localhost'}`);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;

  if (!config.mockApiEnabled || config.nodeEnv === 'production') {
    return respond(res, 404, { error: 'not_found', message: 'Mock API is disabled.' });
  }

  if (req.method === 'GET' && url.pathname === `${PREFIX}/health`) {
    return respond(res, 200, { status: 'ok', mock: true });
  }
  if (req.method === 'GET' && url.pathname === `${PREFIX}/info`) {
    return respond(res, 200, {
      name: 'Soroban Identity Mock API',
      apiVersion: 'v1',
      mock: true,
      endpoints: [
        'GET /mock/v1/health',
        'GET /mock/v1/credentials',
        'GET /mock/v1/credentials/:id',
        'POST /mock/v1/credentials',
        'GET /mock/v1/dids/:address',
        'GET /mock/v1/reputation/:address',
      ],
    });
  }
  if (req.method === 'GET' && url.pathname === `${PREFIX}/credentials`) {
    return respond(res, 200, { items: MOCK_CREDENTIALS, count: MOCK_CREDENTIALS.length, mock: true });
  }
  if (req.method === 'POST' && url.pathname === `${PREFIX}/credentials`) {
    if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return respond(res, 415, { error: 'unsupported_media_type', message: 'Content-Type must be application/json.' });
    }
    let body;
    try {
      body = await readJson(req, { maxBodyBytes: config.maxBodyBytes ?? 64 * 1024 });
    } catch {
      return respond(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON.' });
    }
    if (body.__payloadTooLarge) {
      return respond(res, 413, { error: 'payload_too_large', message: 'Request body exceeds the configured size limit.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(res, 400, { error: 'invalid_request', message: 'Request body must be a JSON object.' });
    }
    return respond(res, 201, {
      credential: {
        ...body,
        id: typeof body.id === 'string' && body.id ? body.id : 'mock-created-credential',
        issuedAt: 1_700_000_000,
        mock: true,
      },
      mock: true,
    });
  }

  const credentialMatch = url.pathname.match(/^\/mock\/v1\/credentials\/([^/]+)$/);
  if (req.method === 'GET' && credentialMatch) {
    const id = decodePathSegment(credentialMatch[1]);
    if (id === null) return respond(res, 400, { error: 'invalid_path', message: 'Credential ID is malformed.' });
    const credential = MOCK_CREDENTIALS.find((item) => item.id === id);
    return credential
      ? respond(res, 200, { credential, mock: true })
      : respond(res, 404, { error: 'credential_not_found', id, mock: true });
  }

  const didMatch = url.pathname.match(/^\/mock\/v1\/dids\/([^/]+)$/);
  if (req.method === 'GET' && didMatch) {
    const address = decodePathSegment(didMatch[1]);
    if (address === null) return respond(res, 400, { error: 'invalid_path', message: 'DID is malformed.' });
    return respond(res, 200, {
      did: `did:stellar:${address}`,
      controller: address,
      document: { id: `did:stellar:${address}`, controller: address },
      mock: true,
    });
  }

  const reputationMatch = url.pathname.match(/^\/mock\/v1\/reputation\/([^/]+)$/);
  if (req.method === 'GET' && reputationMatch) {
    const address = decodePathSegment(reputationMatch[1]);
    if (address === null) return respond(res, 400, { error: 'invalid_path', message: 'Address is malformed.' });
    return respond(res, 200, {
      subject: address,
      score: 72,
      tier: 'trusted',
      reporters: 4,
      mock: true,
    });
  }

  return respond(res, 404, { error: 'mock_endpoint_not_found', path: url.pathname, mock: true });
}
