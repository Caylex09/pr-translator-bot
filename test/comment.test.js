import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import app from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const webhookSecret = 'comment-test-webhook-secret';
const env = {
  GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: webhookSecret, GEMINI_API_KEY: 'comment-test-api-key',
  TARGET_OWNER: 'example-owner', GEMINI_MODEL: 'gemini-3.5-flash-lite',
  TRANSLATION_TIMEOUT_MS: '60000', ALLOW_PRIVATE: 'false',
};
const job = { version: 2, kind: 'issue_comment', installationId: 123,
  owner: 'example-owner', repo: 'demo', number: 42, commentId: 55 };
const marker = '<!-- pr-translator-bot:comment:v1:55 -->';
const prMarker = '<!-- pr-translator-bot:v1 -->';
const issueUrl = 'https://api.github.com/repos/example-owner/demo/issues/42';
const sourceUrl = 'https://github.com/example-owner/demo/pull/42#issuecomment-55';
const translatedBody = '请修复分页问题，保留 `getPage()`。';
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const geminiAnswer = body => json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
  sourceLanguage: 'en', title: '', body,
}) }] } }] });

function payload(overrides = {}) {
  return {
    action: 'created', installation: { id: 123 },
    repository: { name: 'demo', full_name: 'example-owner/demo', private: false,
      owner: { login: 'example-owner' } },
    issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/example-owner/demo/pulls/42' } },
    comment: { id: 55, body: 'stale webhook body', user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
      html_url: 'https://untrusted.example/webhook-link' },
    ...overrides,
  };
}

function request(value = payload(), event = 'issue_comment') {
  const body = JSON.stringify(value);
  return new Request('https://example.workers.dev/webhook', {
    method: 'POST', body, headers: {
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
    },
  });
}

function message(value = job, attempts = 1) {
  const state = { acknowledgements: 0, retries: [] };
  return { body: value, attempts, state,
    ack() { state.acknowledgements += 1; },
    retry(options) { state.retries.push(options); },
  };
}

function mockRemote(t, options = {}) {
  const remote = {
    calls: [], modelInputs: [], logs: [], sourceReads: 0, prReads: 0,
    comments: options.comments ? structuredClone(options.comments) : [],
    deadLetters: [], translationBody: translatedBody,
    source: { id: 55, body: 'Please fix pagination and preserve `getPage()`.', issue_url: issueUrl,
      html_url: 'https://untrusted.example/api-link',
      user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
      ...options.source },
  };
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => remote.logs.push(args.join(' ')));
  }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const endpoint = new URL(url);
    const path = endpoint.pathname;
    const method = init.method || 'GET';
    remote.calls.push({ path, method });
    if (endpoint.hostname === 'generativelanguage.googleapis.com') {
      const modelPayload = JSON.parse(init.body);
      const userText = modelPayload.contents[0].parts[0].text;
      remote.modelInputs.push(JSON.parse(userText.slice(userText.indexOf('\n') + 1)));
      return options.model ? options.model(remote, init) : geminiAnswer(remote.translationBody);
    }
    assert.equal(endpoint.hostname, 'api.github.com');
    assert.equal(init.redirect, 'manual');
    if (path === '/app/installations/123/access_tokens') {
      assert.equal(method, 'POST');
      const token = new Headers(init.headers).get('authorization').slice('Bearer '.length);
      const [header, claims, signature] = token.split('.');
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, env.GITHUB_APP_ID);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
        Buffer.from(signature, 'base64url')), true);
      return json({ token: 'comment-installation-token', permissions: { issues: 'write', pull_requests: 'read' } });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer comment-installation-token');
    if (path === '/repos/example-owner/demo/pulls/42') {
      assert.equal(method, 'GET');
      remote.prReads += 1;
      return json(options.pr ? options.pr(remote.prReads) : {
        state: 'open', title: 'PR title must not be translated for comments', body: 'PR description is unrelated',
        base: { repo: { private: false } },
      });
    }
    if (path === '/repos/example-owner/demo/issues/comments/55') {
      // The original belongs to another author and must never be overwritten.
      assert.equal(method, 'GET');
      remote.sourceReads += 1;
      const status = options.sourceStatus ? options.sourceStatus(remote.sourceReads) : 200;
      return json(status === 200 ? remote.source : { message: 'private deleted comment details' }, status);
    }
    if (path === '/repos/example-owner/demo/issues/42/comments') {
      if (method === 'GET') return json(remote.comments);
      assert.equal(method, 'POST');
      const comment = { id: 400, body: JSON.parse(init.body).body, user: { type: 'Bot' } };
      remote.comments.push(comment);
      return json(comment, 201);
    }
    if (path === '/repos/example-owner/demo/issues/comments/400') {
      assert.equal(method, 'PATCH');
      const existing = remote.comments.find(comment => comment.id === 400);
      assert.ok(existing);
      existing.body = JSON.parse(init.body).body;
      return json(existing);
    }
    throw new Error(`Unexpected mocked endpoint ${path}`);
  });
  remote.bindings = { ...env, TRANSLATION_DLQ: { send: async value => remote.deadLetters.push(value) } };
  return remote;
}

function writes(remote, method) {
  return remote.calls.filter(call => call.method === method && /\/comments(?:\/\d+)?$/.test(call.path));
}

test('created and edited Codex comments enqueue only seven identifiers and no source text or credentials', async t => {
  const remote = mockRemote(t);
  for (const action of ['created', 'edited']) {
    const sent = [];
    const response = await app.fetch(request(payload({ action })), {
      ...env, TRANSLATION_QUEUE: { async send(value) { sent.push(value); } },
    }, { waitUntil() { assert.fail('Queued comments must not start background translation'); } });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'accepted');
    assert.deepEqual(sent, [job]);
    assert.equal(Object.keys(sent[0]).length, 7);
    const stored = JSON.stringify(sent[0]);
    for (const privateValue of ['stale webhook body', 'untrusted.example', webhookSecret,
      env.GEMINI_API_KEY, privateKey, 'chatgpt-codex-connector']) {
      assert.equal(stored.includes(privateValue), false);
    }
  }
  assert.equal(remote.calls.length, 0);
});

test('deleted actions and translation comments are skipped before queueing', async t => {
  const remote = mockRemote(t);
  const cases = [
    payload({ action: 'deleted' }),
    payload({ comment: { id: 55, body: `${prMarker}\nGenerated PR translation` } }),
    payload({ comment: { id: 55, body: `${marker}\nGenerated comment translation` } }),
    payload({ comment: { id: 55, body: 'Own bot comment with marker removed',
      performed_via_github_app: { id: Number(env.GITHUB_APP_ID) } } }),
  ];
  for (const value of cases) {
    const response = await app.fetch(request(value), { ...env,
      TRANSLATION_QUEUE: { send() { assert.fail('Ignored comment must not enter queue'); } },
    }, { waitUntil() { assert.fail('Ignored comment must not translate'); } });
    assert.equal(response.status, 200);
  }
  assert.equal(remote.calls.length, 0);
});

test('malformed comment and PR identifiers cannot enter the translation queue', async t => {
  const remote = mockRemote(t);
  const invalid = [0, -1, 1.5, '55', Number.MAX_SAFE_INTEGER + 1, null];
  for (const id of invalid) {
    const response = await app.fetch(request(payload({ comment: { id, body: 'source' } })), {
      ...env, TRANSLATION_QUEUE: { send() { assert.fail('Invalid comment id must not enter queue'); } },
    }, { waitUntil() { assert.fail('Invalid comment id must not translate'); } });
    assert.equal(response.status, 400, `comment id ${String(id)}`);
  }
  const response = await app.fetch(request(payload({ issue: { number: '42', pull_request: {} } })), {
    ...env, TRANSLATION_QUEUE: { send() { assert.fail('Invalid PR id must not enter queue'); } },
  }, { waitUntil() { assert.fail('Invalid PR id must not translate'); } });
  assert.equal(response.status, 400);
  assert.equal(remote.calls.length, 0);
});

test('signed non-object webhook payloads are rejected without throwing or queueing', async t => {
  const remote = mockRemote(t);
  for (const value of [null, [], 'not a payload', 42]) {
    const response = await app.fetch(request(value), { ...env,
      TRANSLATION_QUEUE: { send() { assert.fail('Malformed payload must not enter queue'); } },
    }, { waitUntil() { assert.fail('Malformed payload must not translate'); } });
    assert.equal(response.status, 400);
  }
  assert.equal(remote.calls.length, 0);
});

test('consumer fetches the current Codex bot comment and posts its translation with a canonical source link', async t => {
  const remote = mockRemote(t);
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.deepEqual(remote.modelInputs, [{ title: '', body: remote.source.body }]);
  assert.equal(remote.sourceReads, 2);
  assert.equal(remote.prReads, 2);
  assert.equal(remote.comments.length, 1);
  const comment = remote.comments[0].body;
  assert.ok(comment.startsWith(`${marker}\n`));
  assert.ok(comment.includes(translatedBody));
  assert.ok(comment.includes(`(${sourceUrl})`));
  assert.doesNotMatch(comment, /untrusted\.example|stale webhook body|PR title must not be translated/);
  assert.equal(writes(remote, 'POST').length, 1);
  assert.equal(writes(remote, 'POST')[0].path, '/repos/example-owner/demo/issues/42/comments');
  assert.equal(writes(remote, 'PATCH').length, 0);
  assert.equal(msg.state.acknowledgements, 1);
  assert.deepEqual(msg.state.retries, []);
  assert.deepEqual(remote.deadLetters, []);
});

test('edited source updates its existing translation while leaving the original and other translations untouched', async t => {
  const remote = mockRemote(t, { comments: [
    { id: 399, body: `${prMarker}\nPR translation`, user: { type: 'Bot' } },
    { id: 400, body: `${marker}\nPrevious comment translation`, user: { type: 'Bot' } },
    { id: 401, body: '<!-- pr-translator-bot:comment:v1:550 -->\nOther source', user: { type: 'Bot' } },
  ] });
  const originalBody = remote.source.body;
  const untouched = [remote.comments[0].body, remote.comments[2].body];
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.source.body, originalBody);
  assert.deepEqual([remote.comments[0].body, remote.comments[2].body], untouched);
  assert.equal(writes(remote, 'POST').length, 0);
  assert.deepEqual(writes(remote, 'PATCH'), [{ path: '/repos/example-owner/demo/issues/comments/400', method: 'PATCH' }]);
  assert.match(remote.comments[1].body, /请修复分页问题/);
  assert.equal(msg.state.acknowledgements, 1);
});

test('a similar comment marker and the PR translation marker cannot capture a different source translation', async t => {
  const remote = mockRemote(t, { comments: [
    { id: 398, body: `${prMarker}\nPR translation`, user: { type: 'Bot' } },
    { id: 399, body: '<!-- pr-translator-bot:comment:v1:550 -->\nOther source', user: { type: 'Bot' } },
  ] });
  const previous = remote.comments.map(comment => comment.body);
  await app.queue({ messages: [message()] }, remote.bindings);
  assert.equal(writes(remote, 'POST').length, 1);
  assert.equal(writes(remote, 'PATCH').length, 0);
  assert.deepEqual(remote.comments.slice(0, 2).map(comment => comment.body), previous);
  assert.ok(remote.comments[2].body.startsWith(`${marker}\n`));
});

test('duplicate comment events reuse one translation without another post or unchanged patch', async t => {
  const remote = mockRemote(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const msg = message();
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(msg.state.acknowledgements, 1);
  }
  assert.equal(remote.modelInputs.length, 2);
  assert.equal(remote.comments.length, 1);
  assert.equal(writes(remote, 'POST').length, 1);
  assert.equal(writes(remote, 'PATCH').length, 0);
});

test('a comment from another PR, deleted source, empty source, and generated sources are acknowledged without translation', async t => {
  const cases = [
    ['different PR', { source: { issue_url: 'https://api.github.com/repos/example-owner/demo/issues/43' } }],
    ['different origin', { source: { issue_url: 'https://untrusted.example/repos/example-owner/demo/issues/42' } }],
    ['different comment id', { source: { id: 56 } }],
    ['deleted source', { sourceStatus: () => 404 }],
    ['empty source', { source: { body: ' \n\t' } }],
    ['generated PR translation', { source: { body: `${prMarker}\nPR translation` } }],
    ['generated comment translation', { source: { body: `${marker}\nComment translation` } }],
    ['own App comment without marker', { source: { body: 'Own comment without marker',
      performed_via_github_app: { id: Number(env.GITHUB_APP_ID) } } }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async subtest => {
      const remote = mockRemote(subtest, options);
      const msg = message();
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 0);
      assert.equal(writes(remote, 'POST').length, 0);
      assert.equal(writes(remote, 'PATCH').length, 0);
      assert.equal(msg.state.acknowledgements, 1);
      assert.deepEqual(msg.state.retries, []);
      assert.deepEqual(remote.deadLetters, []);
      assert.doesNotMatch(remote.logs.join('\n'), /private deleted comment details/);
    });
  }
});

test('comment author user id is independent of App id and cannot suppress another bot', async t => {
  const remote = mockRemote(t, { source: {
    user: { id: Number(env.GITHUB_APP_ID), type: 'Bot', login: 'another-bot[bot]' },
    performed_via_github_app: { id: 987654 },
  } });
  const msg = message();
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.modelInputs.length, 1);
  assert.equal(writes(remote, 'POST').length, 1);
  assert.equal(msg.state.acknowledgements, 1);
});

test('closed or private PRs are rechecked before translating comments and before publishing the result', async t => {
  for (const state of ['closed', 'private']) {
    for (const changesDuringTranslation of [false, true]) {
      await t.test(`${state}, change during translation=${changesDuringTranslation}`, async subtest => {
        const remote = mockRemote(subtest, { pr: read => {
          const changed = !changesDuringTranslation || read > 1;
          return { state: changed && state === 'closed' ? 'closed' : 'open',
            base: { repo: { private: changed && state === 'private' } } };
        } });
        const msg = message();
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(remote.modelInputs.length, changesDuringTranslation ? 1 : 0);
        assert.equal(writes(remote, 'POST').length, 0);
        assert.equal(writes(remote, 'PATCH').length, 0);
        assert.equal(msg.state.acknowledgements, 1);
        assert.deepEqual(msg.state.retries, []);
        assert.deepEqual(remote.deadLetters, []);
      });
    }
  }
});

test('editing the source during model processing retries current text without publishing a stale translation', async t => {
  let editOnce = true;
  const remote = mockRemote(t, { model: current => {
    if (editOnce) {
      editOnce = false;
      current.source.body = 'Latest source after the comment was edited.';
      return geminiAnswer('This stale translation must never be posted.');
    }
    return geminiAnswer('编辑后的最新译文。');
  } });
  const first = message();
  await app.queue({ messages: [first] }, remote.bindings);
  assert.equal(first.state.acknowledgements, 0);
  assert.deepEqual(first.state.retries, [{ delaySeconds: 30 }]);
  assert.equal(writes(remote, 'POST').length, 0);
  assert.equal(writes(remote, 'PATCH').length, 0);
  assert.deepEqual(remote.deadLetters, []);
  const retry = message(job, 2);
  await app.queue({ messages: [retry] }, remote.bindings);
  assert.equal(remote.modelInputs[1].body, 'Latest source after the comment was edited.');
  assert.equal(remote.comments.length, 1);
  assert.match(remote.comments[0].body, /编辑后的最新译文/);
  assert.doesNotMatch(remote.comments[0].body, /stale translation/);
  assert.equal(retry.state.acknowledgements, 1);
});

test('a source deleted or converted to a translation comment during model processing is not published', async t => {
  await t.test('deleted after translation', async subtest => {
    const remote = mockRemote(subtest, { sourceStatus: read => read === 1 ? 200 : 404 });
    const msg = message();
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(remote.modelInputs.length, 1);
    assert.equal(writes(remote, 'POST').length, 0);
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
    assert.deepEqual(remote.deadLetters, []);
  });
  await t.test('converted to generated translation', async subtest => {
    const remote = mockRemote(subtest, { model: current => {
      current.source.body = `${marker}\nGenerated translation`;
      return geminiAnswer(translatedBody);
    } });
    const msg = message();
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(remote.modelInputs.length, 1);
    assert.equal(writes(remote, 'POST').length, 0);
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
  });
  for (const [name, change] of [
    ['changed source id', current => { current.source.id = 56; }],
    ['now identified as own App', current => {
      current.source.performed_via_github_app = { id: Number(env.GITHUB_APP_ID) };
    }],
  ]) {
    await t.test(name, async subtest => {
      const remote = mockRemote(subtest, { model: current => {
        change(current);
        return geminiAnswer(translatedBody);
      } });
      const msg = message();
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 1);
      assert.equal(writes(remote, 'POST').length, 0);
      assert.equal(writes(remote, 'PATCH').length, 0);
      assert.equal(msg.state.acknowledgements, 1);
      assert.deepEqual(msg.state.retries, []);
    });
  }
});

test('invalid version-two queue messages are discarded without sending private fields to DLQ', async t => {
  const remote = mockRemote(t);
  const invalid = [
    { ...job, commentId: 0 }, { ...job, commentId: '55' }, { ...job, kind: 'pull_request_review_comment' },
    { ...job, sourceBody: 'private source must never reach DLQ' }, { ...job, version: 1 },
  ];
  const messages = invalid.map(value => message(value));
  await app.queue({ messages }, remote.bindings);
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(remote.deadLetters, []);
  for (const msg of messages) {
    assert.equal(msg.state.acknowledgements, 1);
    assert.deepEqual(msg.state.retries, []);
  }
  assert.doesNotMatch(remote.logs.join('\n'), /private source must never reach DLQ/);
});

test('comment translation also works in the original background mode without a queue binding', async t => {
  const remote = mockRemote(t);
  const jobs = [];
  const response = await app.fetch(request(), { ...env, TRANSLATION_TIMEOUT_MS: '20000' },
    { waitUntil: promise => jobs.push(promise) });
  assert.equal(response.status, 202);
  assert.equal(jobs.length, 1);
  await Promise.all(jobs);
  assert.equal(remote.comments.length, 1);
  assert.ok(remote.comments[0].body.startsWith(marker));
});
