import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import app from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const webhookSecret = 'queue-test-webhook-secret';
const env = {
  GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: webhookSecret, GEMINI_API_KEY: 'queue-test-api-key',
  TARGET_OWNER: 'example-owner', GEMINI_MODEL: 'gemini-3.5-flash-lite',
  TRANSLATION_TIMEOUT_MS: '60000', ALLOW_PRIVATE: 'false',
};
const job = { version: 1, installationId: 123, owner: 'example-owner', repo: 'demo', number: 42 };
const translation = { sourceLanguage: 'zh', title: 'Fix Markdown', body: 'Fix pagination issue' };
// WebCrypto signs on a worker thread; yield briefly even while timer mocks are active.
const nativeSetTimeout = globalThis.setTimeout;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const geminiAnswer = () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(translation) }] } }] });

function request() {
  const body = JSON.stringify({
    action: 'edited', installation: { id: 123 },
    repository: { name: 'demo', full_name: 'example-owner/demo', private: false, owner: { login: 'example-owner' } },
    pull_request: { number: 42, title: 'stale webhook title', body: 'private webhook body' },
  });
  return new Request('https://example.workers.dev/webhook', {
    method: 'POST', body, headers: {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
    },
  });
}

function message(attempts = 1, body = job) {
  const state = { acknowledgements: 0, retries: [] };
  return { body, attempts, state,
    ack() { state.acknowledgements += 1; },
    retry(options) { state.retries.push(options); },
  };
}

function mockRemote(t, options = {}) {
  const remote = { calls: [], comments: [], modelCalls: 0, deadLetters: [], logs: [] };
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => remote.logs.push(args.join(' ')));
  }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const endpoint = new URL(url);
    const path = endpoint.pathname;
    remote.calls.push({ path, method: init.method || 'GET' });
    if (endpoint.hostname === 'generativelanguage.googleapis.com') {
      remote.modelCalls += 1;
      const payload = JSON.parse(init.body);
      assert.match(JSON.stringify(payload), /current PR title/);
      assert.doesNotMatch(JSON.stringify(payload), /stale webhook title|private webhook body/);
      return options.model ? options.model(init, remote) : geminiAnswer();
    }
    assert.equal(endpoint.hostname, 'api.github.com');
    assert.equal(init.redirect, 'manual');
    if (path.endsWith('/access_tokens')) {
      const jwt = new Headers(init.headers).get('authorization').slice('Bearer '.length);
      const [header, claims, signature] = jwt.split('.');
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, env.GITHUB_APP_ID);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
        Buffer.from(signature, 'base64url')), true);
      if (options.installation) return options.installation(init, remote);
      return json({ token: 'installation-token-must-stay-private', permissions: options.permissions || { issues: 'write', pull_requests: 'read' } });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer installation-token-must-stay-private');
    if (path.endsWith('/pulls/42')) return json({ state: options.prState || 'open',
      title: 'current PR title 修复', body: 'current PR description',
      base: { repo: { private: options.isPrivate || false } },
    });
    if (path.endsWith('/comments') && init.method === 'POST') {
      if (options.commentStatus) return json({ message: 'sensitive API response body' }, options.commentStatus);
      const comment = { id: 400, body: JSON.parse(init.body).body, user: { type: 'Bot' } };
      remote.comments.push(comment);
      return json(comment, 201);
    }
    if (path.endsWith('/comments')) return json(remote.comments);
    throw new Error(`Unexpected mocked endpoint ${path}`);
  });
  remote.bindings = { ...env, TRANSLATION_DLQ: { send: async value => remote.deadLetters.push(value) } };
  return remote;
}

async function until(predicate) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (predicate()) return;
    await new Promise(resolve => nativeSetTimeout(resolve, 1));
  }
  assert.fail('Expected mocked request did not start');
}

test('webhook persists only compact identifiers before acknowledging acceptance', async t => {
  const remote = mockRemote(t);
  let release;
  let sent;
  let settled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const responsePromise = app.fetch(request(), {
    ...env, TRANSLATION_QUEUE: { async send(value) { sent = value; await gate; } },
  }, { waitUntil() { assert.fail('Queue mode must not use waitUntil'); } });
  responsePromise.then(() => { settled = true; });
  await until(() => sent !== undefined);
  assert.deepEqual(sent, job);
  assert.equal(settled, false);
  assert.equal(remote.calls.length, 0);
  const stored = JSON.stringify(sent);
  for (const sensitive of ['stale webhook title', 'private webhook body', env.GEMINI_API_KEY, privateKey, 'token']) {
    assert.equal(stored.includes(sensitive), false);
  }
  release();
  const response = await responsePromise;
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'accepted');
});

test('failed queue write returns 503 without starting translation or logging raw errors', async t => {
  const remote = mockRemote(t);
  const response = await app.fetch(request(), { ...env,
    TRANSLATION_QUEUE: { async send() { throw new Error(`sensitive failure ${env.GEMINI_API_KEY}`); } },
  }, { waitUntil() { assert.fail('Failed persistence must not run background work'); } });
  assert.equal(response.status, 503);
  assert.equal(remote.calls.length, 0);
  assert.doesNotMatch(remote.logs.join('\n'), /sensitive failure|queue-test-api-key/);
});

test('successful and duplicate queued deliveries reuse an unchanged bot comment', async t => {
  const remote = mockRemote(t);
  for (let duplicate = 0; duplicate < 2; duplicate += 1) {
    const msg = message();
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
  }
  assert.equal(remote.modelCalls, 2);
  assert.equal(remote.comments.length, 1);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/comments')).length, 1);
  assert.equal(remote.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.deepEqual(remote.deadLetters, []);
});

test('consumer refetches current closed/private state and skips translation', async t => {
  for (const [name, options] of [['closed PR', { prState: 'closed' }], ['now-private repository', { isPrivate: true }]]) {
    await t.test(name, async subtest => {
      const remote = mockRemote(subtest, options);
      const msg = message();
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.calls.some(call => call.path.endsWith('/pulls/42')), true);
      assert.equal(remote.modelCalls, 0);
      assert.equal(msg.state.acknowledgements, 1);
      assert.deepEqual(msg.state.retries, []);
      assert.deepEqual(remote.deadLetters, []);
    });
  }
});

test('owner mismatch and invalid queued messages are acknowledged without fetching or forwarding data', async t => {
  const remote = mockRemote(t);
  const messages = [message(1, { ...job, owner: 'other-owner' }),
    message(1, { ...job, body: 'private content must not reach DLQ' }),
    message(1, { ...job, repo: '../unsafe' }), message(1, { ...job, number: 0 })];
  await app.queue({ messages }, remote.bindings);
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(remote.deadLetters, []);
  for (const msg of messages) assert.equal(msg.state.acknowledgements, 1);
  assert.doesNotMatch(remote.logs.join('\n'), /private content must not reach DLQ/);
});

test('temporary provider errors use 30/60/120 second retries and dead-letter the fourth failure', async t => {
  for (const status of [429, 500, 503]) {
    await t.test(`HTTP ${status}`, async subtest => {
      const remote = mockRemote(subtest, { model: () => json({}, status) });
      for (const [index, delaySeconds] of [30, 60, 120].entries()) {
        const msg = message(index + 1);
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(msg.state.acknowledgements, 0);
        assert.deepEqual(msg.state.retries, [{ delaySeconds }]);
      }
      const exhausted = message(4);
      await app.queue({ messages: [exhausted] }, remote.bindings);
      assert.equal(exhausted.state.acknowledgements, 1);
      assert.deepEqual(exhausted.state.retries, []);
      assert.deepEqual(remote.deadLetters, [job]);
      assert.equal(remote.modelCalls, 4);
    });
  }
});

test('provider timeout uses the full queue budget and schedules a retry without a real wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const remote = mockRemote(t, { model: init => { signal = init.signal; return new Promise(() => {}); } });
  const msg = message();
  const running = app.queue({ messages: [msg] }, remote.bindings);
  await until(() => remote.modelCalls === 1);
  t.mock.timers.tick(20000);
  assert.equal(signal.aborted, false);
  assert.deepEqual(msg.state.retries, []);
  t.mock.timers.tick(40000);
  await running;
  assert.equal(signal.aborted, true);
  assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
  assert.equal(msg.state.acknowledgements, 0);
});

test('network errors are retried without exposing the raw exception', async t => {
  const remote = mockRemote(t, { model: () => { throw new Error(`private network detail ${env.GEMINI_API_KEY}`); } });
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
  assert.doesNotMatch(remote.logs.join('\n'), /private network detail|queue-test-api-key/);
});

test('permanent GitHub 403 and missing provider secret go to DLQ without automatic model retries', async t => {
  await t.test('GitHub comment write denied', async subtest => {
    const remote = mockRemote(subtest, { commentStatus: 403 });
    const msg = message();
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(remote.modelCalls, 1);
    assert.deepEqual(remote.deadLetters, [job]);
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
    assert.doesNotMatch(remote.logs.join('\n'), /sensitive API response body/);
  });
  await t.test('missing provider secret', async subtest => {
    const remote = mockRemote(subtest);
    const msg = message();
    await app.queue({ messages: [msg] }, { ...remote.bindings, GEMINI_API_KEY: undefined });
    assert.equal(remote.modelCalls, 0);
    assert.deepEqual(remote.deadLetters, [job]);
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
  });
});

test('actual read-only installation permissions stop before Gemini and log no credentials', async t => {
  const remote = mockRemote(t, { permissions: { issues: 'read', pull_requests: 'read', unexpected: 'token-value' } });
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.modelCalls, 0);
  assert.equal(remote.calls.some(call => call.path.endsWith('/pulls/42')), false);
  assert.deepEqual(remote.deadLetters, [job]);
  assert.equal(msg.state.acknowledgements, 1);
  assert.deepEqual(msg.state.retries, []);
  assert.match(remote.logs.join('\n'), /issues=read, pull_requests=read/);
  assert.doesNotMatch(remote.logs.join('\n'), /installation-token-must-stay-private|token-value|PRIVATE KEY|queue-test-api-key/);
});

test('Pull requests write permission is sufficient without Issues write permission', async t => {
  const remote = mockRemote(t, { permissions: { issues: 'read', pull_requests: 'write' } });
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.modelCalls, 1);
  assert.equal(remote.comments.length, 1);
  assert.equal(msg.state.acknowledgements, 1);
});

test('permanent failures are acknowledged only after DLQ persistence; a failed write retains the original job', async t => {
  await t.test('await persistence', async subtest => {
    const remote = mockRemote(subtest, { permissions: { issues: 'read', pull_requests: 'read' } });
    let release;
    let sent;
    const gate = new Promise(resolve => { release = resolve; });
    const msg = message();
    const running = app.queue({ messages: [msg] }, { ...remote.bindings,
      TRANSLATION_DLQ: { async send(value) { sent = value; await gate; } },
    });
    await until(() => sent !== undefined);
    assert.deepEqual(sent, job);
    assert.equal(msg.state.acknowledgements, 0);
    release();
    await running;
    assert.equal(msg.state.acknowledgements, 1);
  });
  await t.test('failed persistence', async subtest => {
    const remote = mockRemote(subtest, { permissions: { issues: 'read', pull_requests: 'read' } });
    const msg = message();
    await app.queue({ messages: [msg] }, { ...remote.bindings,
      TRANSLATION_DLQ: { async send() { throw new Error('private DLQ network detail'); } },
    });
    assert.equal(msg.state.acknowledgements, 0);
    assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
    assert.doesNotMatch(remote.logs.join('\n'), /private DLQ network detail/);
  });
});

test('hung GitHub headers or body time out and retry before translation', async t => {
  for (const phase of ['headers', 'body']) {
    await t.test(phase, async subtest => {
      subtest.mock.timers.enable({ apis: ['setTimeout'] });
      let signal;
      const remote = mockRemote(subtest, { installation: init => {
        signal = init.signal;
        return phase === 'headers' ? new Promise(() => {})
          : { ok: true, status: 200, text: () => new Promise(() => {}) };
      } });
      const msg = message();
      const running = app.queue({ messages: [msg] }, remote.bindings);
      await until(() => signal !== undefined);
      subtest.mock.timers.tick(10000);
      await running;
      assert.equal(signal.aborted, true);
      assert.equal(remote.modelCalls, 0);
      assert.equal(msg.state.acknowledgements, 0);
      assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
    });
  }
});
