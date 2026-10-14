import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import app from '../src/index.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const secret = 'my test secret';
const env = {
  GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: secret, GEMINI_API_KEY: 'fake-key',
  TARGET_OWNER: 'example-owner', GEMINI_MODEL: 'gemini-3.5-flash-lite',
  ALLOW_PRIVATE: 'false',
};

function makeRequest(action = 'opened', isPrivate = false) {
  const body = JSON.stringify({
    action, installation: { id: 123 },
    repository: { name: 'demo', full_name: 'example-owner/demo', private: isPrivate, owner: { login: 'example-owner' } },
    pull_request: { number: 42 },
  });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return new Request('https://example.workers.dev/webhook', {
    method: 'POST', body,
    headers: { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=' + signature },
  });
}

const respond = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('creates one PR translation comment and skips rewriting an unchanged result', async () => {
  const oldFetch = globalThis.fetch;
  const remote = { comments: [], calls: [] };
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    remote.calls.push([path, init.method || 'GET']);
    if (path.endsWith('/access_tokens')) return respond({ token: 'install-token' });
    if (path.endsWith('/pulls/42')) return respond({ state: 'open', title: '修复 Markdown', body: '修复分页问题' });
    if (path.endsWith('/comments') && init.method === 'POST') {
      const { body } = JSON.parse(init.body);
      remote.comments.push({ id: 400, body, user: { type: 'Bot' } });
      return respond({ id: 400 }, 201);
    }
    if (path.endsWith('/comments')) return respond(remote.comments);
    if (path.endsWith('/comments/400') && init.method === 'PATCH') {
      remote.comments[0].body = JSON.parse(init.body).body;
      return respond(remote.comments[0]);
    }
    if (path.includes('generateContent')) {
      return respond({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        sourceLanguage: 'zh', title: 'Fix Markdown', body: 'Fix pagination issue',
      }) }] } }] });
    }
    throw new Error('Unexpected fetch ' + path);
  };
  try {
    for (const action of ['opened', 'edited']) {
      const jobs = [];
      const response = await app.fetch(makeRequest(action), env, { waitUntil: promise => jobs.push(promise) });
      assert.equal(response.status, 202);
      await Promise.all(jobs);
    }
    assert.equal(remote.comments.length, 1);
    assert.match(remote.comments[0].body, /Fix Markdown/);
    assert.equal(remote.calls.filter(([path, method]) => path.endsWith('/comments') && method === 'POST').length, 1);
    assert.equal(remote.calls.filter(([path, method]) => method === 'PATCH').length, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('private PRs are skipped by default', async () => {
  const jobs = [];
  const response = await app.fetch(makeRequest('opened', true), env, { waitUntil: promise => jobs.push(promise) });
  assert.equal(response.status, 200);
  assert.deepEqual(jobs, []);
});

test('provider quota exhaustion falls back and posts only the successful translation comment', async t => {
  const remote = { comments: [], translationAttempts: [] };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const endpoint = new URL(url);
    const path = endpoint.pathname;
    if (endpoint.hostname === 'generativelanguage.googleapis.com') {
      remote.translationAttempts.push('gemini');
      return respond({ error: { message: 'quota exhausted' } }, 429);
    }
    if (endpoint.hostname === 'backup.example') {
      remote.translationAttempts.push('openai');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fallback-key');
      assert.equal(JSON.parse(init.body).model, 'backup-model');
      return respond({ choices: [{ message: { content: JSON.stringify({
        sourceLanguage: 'zh', title: 'Fix Markdown', body: 'Fix pagination issue',
      }) } }] });
    }
    if (path.endsWith('/access_tokens')) return respond({ token: 'install-token' });
    if (path.endsWith('/pulls/42')) return respond({ state: 'open', title: '修复 Markdown', body: '修复分页问题' });
    if (path.endsWith('/comments') && init.method === 'POST') {
      remote.comments.push(JSON.parse(init.body).body);
      return respond({ id: 401 }, 201);
    }
    if (path.endsWith('/comments')) return respond([]);
    throw new Error('Unexpected fetch ' + endpoint.origin + path);
  });
  const configuredEnv = {
    ...env, FALLBACK_API_KEY: 'fallback-key',
    TRANSLATION_PROVIDERS: JSON.stringify([
      { name: 'gemini-primary', type: 'gemini', model: 'gemini-test', api_key_env: 'GEMINI_API_KEY' },
      { name: 'openai-backup', type: 'openai', model: 'backup-model', api_key_env: 'FALLBACK_API_KEY', base_url: 'https://backup.example/v1' },
    ]),
  };
  const jobs = [];
  const response = await app.fetch(makeRequest(), configuredEnv, { waitUntil: promise => jobs.push(promise) });
  assert.equal(response.status, 202);
  await Promise.all(jobs);
  assert.deepEqual(remote.translationAttempts, ['gemini', 'openai']);
  assert.equal(remote.comments.length, 1);
  assert.match(remote.comments[0], /Fix Markdown/);
  assert.match(remote.comments[0], /Fix pagination issue/);
});
