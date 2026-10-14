import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import app from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const secret = 'content-test-webhook-secret';
const env = {
  GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: secret, GEMINI_API_KEY: 'content-test-api-key',
  TARGET_OWNER: 'example-owner', GEMINI_MODEL: 'gemini-3.5-flash-lite',
  TRANSLATION_TIMEOUT_MS: '60000', ALLOW_PRIVATE: 'false',
};
const baseJob = { version: 3, installationId: 123, owner: 'example-owner', repo: 'demo', number: 42 };
const kinds = ['issue', 'issue_comment', 'review', 'review_comment'];
const sourceIds = { issue_comment: 55, review: 66, review_comment: 77 };
const markers = {
  issue: '<!-- pr-translator-bot:issue:v1 -->',
  issue_comment: '<!-- pr-translator-bot:issue-comment:v1:55 -->',
  review: '<!-- pr-translator-bot:review:v1:66 -->',
  review_comment: '<!-- pr-translator-bot:review-comment:v1:77 -->',
};
const paths = {
  issue: '/repos/example-owner/demo/issues/42',
  issue_comment: '/repos/example-owner/demo/issues/comments/55',
  review: '/repos/example-owner/demo/pulls/42/reviews/66',
  review_comment: '/repos/example-owner/demo/pulls/comments/77',
};
const events = { issue: 'issues', issue_comment: 'issue_comment',
  review: 'pull_request_review', review_comment: 'pull_request_review_comment' };
const urls = {
  issue_comment: 'https://github.com/example-owner/demo/issues/42#issuecomment-55',
  review: 'https://github.com/example-owner/demo/pull/42#pullrequestreview-66',
  review_comment: 'https://github.com/example-owner/demo/pull/42#discussion_r77',
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const geminiAnswer = (body = '最新译文。', title = '译文标题') => json({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ sourceLanguage: 'en', title, body }) }] } }],
});

function job(kind) {
  return { ...baseJob, kind, ...(kind === 'issue' ? {} : { sourceId: sourceIds[kind] }) };
}

function payload(kind, action) {
  const common = {
    action: action || (kind === 'issue' ? 'opened' : kind === 'review' ? 'submitted' : 'created'),
    installation: { id: 123 },
    repository: { name: 'demo', full_name: 'example-owner/demo', private: false,
      owner: { login: 'example-owner' } },
  };
  const source = { id: sourceIds[kind], body: 'Cached source should not enter queue',
    html_url: 'https://untrusted.example/cached-link',
    user: { type: 'Bot', login: 'chatgpt-codex-connector[bot]' } };
  if (kind === 'issue') return { ...common, issue: { number: 42, title: 'Cached title', body: 'Cached issue body' } };
  if (kind === 'issue_comment') return { ...common, issue: { number: 42 }, comment: source };
  if (kind === 'review') return { ...common, pull_request: { number: 42 }, review: { ...source, state: 'commented' } };
  return { ...common, pull_request: { number: 42 }, comment: source };
}

function request(kind, value = payload(kind)) {
  const body = JSON.stringify(value);
  return new Request('https://example.workers.dev/webhook', {
    method: 'POST', body, headers: {
      'X-GitHub-Event': events[kind],
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  });
}

function message(value, attempts = 1) {
  const state = { acknowledgements: 0, retries: [] };
  return { body: value, attempts, state,
    ack() { state.acknowledgements += 1; },
    retry(options) { state.retries.push(options); },
  };
}

function mockRemote(t, kind, options = {}) {
  const remote = {
    calls: [], modelInputs: [], logs: [], reads: {}, comments: structuredClone(options.comments || []),
    deadLetters: [], threadComments: structuredClone(options.threadComments || []), source: kind === 'issue'
      ? { number: 42, state: 'open', title: 'Current issue title', body: 'Current issue description', ...options.source }
      : { id: sourceIds[kind], body: 'Current source: keep `calculate()` and Markdown.',
        issue_url: 'https://api.github.com/repos/example-owner/demo/issues/42',
        pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/42',
        state: 'COMMENTED', html_url: kind === 'review'
          ? 'https://github.com/example-owner/demo/pull/42#ignored-api-fragment'
          : 'https://untrusted.example/current-link',
        user: { type: 'Bot', login: 'chatgpt-codex-connector[bot]' }, ...options.source },
  };
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => remote.logs.push(args.join(' ')));
  }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init.method || 'GET';
    remote.calls.push({ path, method });
    if (parsed.hostname === 'generativelanguage.googleapis.com') {
      const input = JSON.parse(init.body).contents[0].parts[0].text;
      remote.modelInputs.push(JSON.parse(input.slice(input.indexOf('\n') + 1)));
      return options.model ? options.model(remote) : geminiAnswer();
    }
    assert.equal(parsed.hostname, 'api.github.com');
    assert.equal(init.redirect, 'manual');
    if (path === '/app/installations/123/access_tokens') {
      assert.equal(method, 'POST');
      const [header, claims, signature] = new Headers(init.headers).get('authorization').slice(7).split('.');
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, env.GITHUB_APP_ID);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
        Buffer.from(signature, 'base64url')), true);
      return json({ token: 'content-test-installation-token',
        permissions: Object.hasOwn(options, 'permissions') ? options.permissions : { issues: 'write', pull_requests: 'write' } });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer content-test-installation-token');
    remote.reads[path] = (remote.reads[path] || 0) + 1;
    const count = remote.reads[path];
    if (path === '/repos/example-owner/demo') {
      assert.equal(method, 'GET');
      return json(options.repo ? options.repo(count, remote) : { private: false });
    }
    if (path === paths[kind]) {
      // No processor may edit the source Issue, review, or inline comment.
      assert.equal(method, 'GET');
      const status = options.sourceStatus ? options.sourceStatus(count, remote) : 200;
      return json(status === 200 ? remote.source : { message: 'Private source error detail' }, status);
    }
    if (path === '/repos/example-owner/demo/issues/42' || path === '/repos/example-owner/demo/pulls/42') {
      assert.equal(method, 'GET');
      return json(options.container ? options.container(count, remote) : {
        number: 42, state: 'open', title: 'Container title must not become a comment input',
        body: 'Container description is unrelated', base: { repo: { private: false } },
      });
    }
    if (path === '/repos/example-owner/demo/issues/42/comments') {
      if (method === 'GET') return json(remote.comments);
      assert.equal(method, 'POST');
      const result = { id: 400, body: JSON.parse(init.body).body, user: { type: 'Bot' } };
      remote.comments.push(result);
      return json(result, 201);
    }
    if (path === '/repos/example-owner/demo/issues/comments/400') {
      assert.equal(method, 'PATCH');
      const result = remote.comments.find(value => value.id === 400);
      assert.ok(result);
      result.body = JSON.parse(init.body).body;
      return json(result);
    }
    if (path === '/repos/example-owner/demo/pulls/42/comments') {
      assert.equal(method, 'GET');
      return json(options.threadPage ? options.threadPage(Number(parsed.searchParams.get('page')), remote) : remote.threadComments);
    }
    if (path === '/repos/example-owner/demo/pulls/comments/88') {
      assert.equal(method, 'GET');
      return json(options.root || { id: 88, body: 'Thread root',
        pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/42' });
    }
    if (/^\/repos\/example-owner\/demo\/pulls\/42\/comments\/\d+\/replies$/.test(path)) {
      assert.equal(method, 'POST');
      const result = { id: 500, body: JSON.parse(init.body).body, user: { type: 'Bot' },
        in_reply_to_id: Number(path.split('/').at(-2)) };
      remote.threadComments.push(result);
      return json(result, 201);
    }
    if (path === '/repos/example-owner/demo/pulls/comments/500') {
      assert.equal(method, 'PATCH');
      const result = remote.threadComments.find(value => value.id === 500);
      assert.ok(result);
      result.body = JSON.parse(init.body).body;
      return json(result);
    }
    throw new Error(`Unexpected mocked endpoint ${path}`);
  });
  remote.bindings = { ...env, TRANSLATION_DLQ: { send: async value => remote.deadLetters.push(value) } };
  return remote;
}

function writes(remote, method) {
  return remote.calls.filter(value => value.method === method && value.path.includes('/comments'));
}

function acknowledged(msg) {
  assert.equal(msg.state.acknowledgements, 1);
  assert.deepEqual(msg.state.retries, []);
}

test('Issue, ordinary Issue comment, Review and inline comment events queue identifiers only', async t => {
  for (const kind of kinds) {
    const actions = kind === 'issue' ? ['opened', 'edited', 'reopened']
      : kind === 'review' ? ['submitted', 'edited'] : ['created', 'edited'];
    for (const action of actions) {
      await t.test(`${kind} ${action}`, async () => {
        const sent = [];
        const response = await app.fetch(request(kind, payload(kind, action)), {
          ...env, TRANSLATION_QUEUE: { send: async value => sent.push(value) },
        }, { waitUntil() { assert.fail('Queueing must not translate source text'); } });
        assert.equal(response.status, 202);
        assert.deepEqual(sent, [{ ...job(kind), version: kind === 'review' || kind === 'review_comment' ? 4 : 3 }]);
        assert.equal(Object.keys(sent[0]).length, kind === 'issue' ? 6 : 7);
        for (const forbidden of ['Cached', 'untrusted.example', secret, privateKey, env.GEMINI_API_KEY,
          'chatgpt-codex-connector']) assert.equal(JSON.stringify(sent[0]).includes(forbidden), false);
      });
    }
  }
});

test('new event routes reject wrong actions, private repositories and another owner before queueing', async t => {
  for (const kind of kinds) {
    for (const change of ['wrong action', 'private', 'owner']) {
      await t.test(`${kind} ${change}`, async () => {
        const value = payload(kind);
        if (change === 'wrong action') value.action = 'deleted';
        if (change === 'private') value.repository.private = true;
        if (change === 'owner') value.repository.owner.login = 'different-owner';
        const response = await app.fetch(request(kind, value), {
          ...env, TRANSLATION_QUEUE: { send() { assert.fail('Filtered event must not enter queue'); } },
        }, { waitUntil() { assert.fail('Filtered event must not translate'); } });
        assert.equal(response.status, 200);
      });
    }
  }
});

test('issues webhook does not translate a PR twice and PR discussion keeps its existing version-two job', async () => {
  const issue = payload('issue');
  issue.issue.pull_request = { url: 'https://api.github.com/repos/example-owner/demo/pulls/42' };
  const response = await app.fetch(request('issue', issue), {
    ...env, TRANSLATION_QUEUE: { send() { assert.fail('PR must use pull_request event'); } },
  }, { waitUntil() { assert.fail('Duplicate source must not translate'); } });
  assert.equal(response.status, 200);
  const sent = [];
  const discussion = payload('issue_comment');
  discussion.issue.pull_request = {};
  const accepted = await app.fetch(request('issue_comment', discussion), {
    ...env, TRANSLATION_QUEUE: { send: async value => sent.push(value) },
  }, { waitUntil() { assert.fail('Queued PR comment must not translate immediately'); } });
  assert.equal(accepted.status, 202);
  assert.deepEqual(sent, [{ version: 2, kind: 'issue_comment', installationId: 123,
    owner: 'example-owner', repo: 'demo', number: 42, commentId: 55 }]);
});

test('every generated marker and the current App are excluded while other bots remain eligible', async t => {
  for (const kind of ['issue_comment', 'review', 'review_comment']) {
    for (const body of [...Object.values(markers), '<!-- pr-translator-bot:v1 -->',
      '<!-- pr-translator-bot:comment:v1:55 -->', 'own App source']) {
      await t.test(`${kind}: ${body}`, async () => {
        const value = payload(kind);
        const source = kind === 'review' ? value.review : value.comment;
        source.body = body;
        if (body === 'own App source') source.performed_via_github_app = { id: Number(env.GITHUB_APP_ID) };
        const response = await app.fetch(request(kind, value), {
          ...env, TRANSLATION_QUEUE: { send() { assert.fail('Own translations cannot recurse'); } },
        }, { waitUntil() { assert.fail('Own translations cannot recurse'); } });
        assert.equal(response.status, 200);
      });
    }
  }
});

test('invalid source identifiers cannot enter new queues', async t => {
  for (const kind of ['issue_comment', 'review', 'review_comment']) {
    for (const id of [0, '55', Number.MAX_SAFE_INTEGER + 1]) {
      await t.test(`${kind} id=${id}`, async () => {
        const value = payload(kind);
        (kind === 'review' ? value.review : value.comment).id = id;
        const response = await app.fetch(request(kind, value), {
          ...env, TRANSLATION_QUEUE: { send() { assert.fail('Invalid source id cannot enter queue'); } },
        }, { waitUntil() { assert.fail('Invalid source id cannot translate'); } });
        assert.equal(response.status, 400);
      });
    }
  }
});

test('each new consumer translates fresh content and links comments back to their canonical source', async t => {
  for (const kind of kinds) {
    await t.test(kind, async subtest => {
      const remote = mockRemote(subtest, kind);
      const original = structuredClone(remote.source);
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.deepEqual(remote.modelInputs, [{ title: kind === 'issue' ? original.title : '', body: original.body }]);
      assert.equal(remote.reads[paths[kind]], 2);
      assert.deepEqual(remote.source, original);
      const translations = kind === 'review_comment' ? remote.threadComments : remote.comments;
      assert.equal(translations.length, 1);
      assert.ok(translations[0].body.startsWith(`${markers[kind]}\n`));
      assert.match(translations[0].body, /最新译文/);
      if (kind === 'issue') assert.match(translations[0].body, /译文标题/);
      else assert.ok(translations[0].body.includes(`(${urls[kind]})`));
      assert.doesNotMatch(translations[0].body, /untrusted\.example|Cached|Container title/);
      assert.deepEqual(writes(remote, 'POST'), [{ path: kind === 'review_comment'
        ? '/repos/example-owner/demo/pulls/42/comments/77/replies' : '/repos/example-owner/demo/issues/42/comments', method: 'POST' }]);
      assert.equal(writes(remote, 'PATCH').length, 0);
      acknowledged(msg);
      assert.deepEqual(remote.deadLetters, []);
    });
  }
});

test('inline translations stay in the original thread and are updated instead of duplicated', async t => {
  const remote = mockRemote(t, 'review_comment', { source: { in_reply_to_id: 88 } });
  for (let iteration = 0; iteration < 2; iteration++) {
    const msg = message(job('review_comment'));
    await app.queue({ messages: [msg] }, remote.bindings);
    acknowledged(msg);
  }
  assert.deepEqual(writes(remote, 'POST'), [{ path: '/repos/example-owner/demo/pulls/42/comments/88/replies', method: 'POST' }]);
  assert.equal(remote.comments.length, 0);
  assert.equal(remote.threadComments.length, 1);
  assert.equal(remote.threadComments[0].in_reply_to_id, 88);
  assert.match(remote.threadComments[0].body, /#discussion_r77/);
  assert.match(remote.threadComments[0].body, /\[Thread\].*#discussion_r88/);
  assert.equal(writes(remote, 'PATCH').length, 0);
  remote.source.body = 'Edited inline reply';
  const edited = message(job('review_comment'));
  await app.queue({ messages: [edited] }, remote.bindings);
  // A stable translation does not cause a second notification.
  assert.equal(writes(remote, 'PATCH').length, 0);
  acknowledged(edited);
});

test('an edited inline source patches only its translation in the correct thread', async t => {
  const remote = mockRemote(t, 'review_comment', { source: { in_reply_to_id: 88 }, threadComments: [
    { id: 499, body: `${markers.review_comment}\nWrong thread`, in_reply_to_id: 99, user: { type: 'Bot' } },
    { id: 500, body: `${markers.review_comment}\nOld translation`, in_reply_to_id: 88, user: { type: 'Bot' } },
    { id: 501, body: '<!-- pr-translator-bot:review-comment:v1:770 -->\nOther source', in_reply_to_id: 88, user: { type: 'Bot' } },
  ] });
  const msg = message(job('review_comment'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.deepEqual(writes(remote, 'PATCH'), [{ path: '/repos/example-owner/demo/pulls/comments/500', method: 'PATCH' }]);
  assert.match(remote.threadComments[0].body, /Wrong thread/);
  assert.match(remote.threadComments[2].body, /Other source/);
  assert.equal(writes(remote, 'POST').length, 0);
  acknowledged(msg);
});

test('inline metadata uses the original reviewed location and safe file text after newer pushes', async t => {
  const commit = 'c6907a4f203a3d0520dc584e2aedee9f3bdd8268';
  const remote = mockRemote(t, 'review_comment', { source: {
    original_commit_id: commit, original_start_line: 14, original_line: 16,
    line: null, path: 'src/[name]`<script>&.js', pull_request_review_id: 66,
  }, model: current => {
    current.source.user.login = 'updated-author';
    return geminiAnswer();
  } });
  const msg = message(job('review_comment'));
  await app.queue({ messages: [msg] }, remote.bindings);
  const body = remote.threadComments[0].body;
  assert.match(body, /Author: <code>updated-author<\/code>/);
  assert.ok(body.includes(`https://github.com/example-owner/demo/commit/${commit}`));
  assert.match(body, /Original line: 14–16 · Outdated location/);
  assert.match(body, /#pullrequestreview-66/);
  assert.ok(body.includes('<code>src/[name]`&lt;script&gt;&amp;.js</code>'));
  assert.doesNotMatch(body, /<script>/);
  acknowledged(msg);
});

test('review translations identify the actual author and reviewed commit', async t => {
  const commit = '7c8f7c2155a049b10656bb98c3eed8ede3911c88';
  const remote = mockRemote(t, 'review', { source: { commit_id: commit } });
  const msg = message(job('review'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.match(remote.comments[0].body, /chatgpt-codex-connector\[bot\]/);
  assert.match(remote.comments[0].body, /Reviewed commit 7c8f7c2155/);
  assert.ok(remote.comments[0].body.includes(`/commit/${commit}`));
  assert.match(remote.comments[0].body, /#pullrequestreview-66/);
  acknowledged(msg);
});

test('a missing or mismatched root cannot redirect a reply to another review thread', async t => {
  for (const root of [null,
    { id: 88, pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/43' },
    { id: 88, pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/42', in_reply_to_id: 99 },
  ]) await t.test(JSON.stringify(root), async subtest => {
    const remote = mockRemote(subtest, 'review_comment', { source: { in_reply_to_id: 88 },
      root: root || { id: 0 } });
    const msg = message(job('review_comment'));
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(writes(remote, 'POST').length, 0);
    acknowledged(msg);
  });
});

test('inline replies require approved Pull requests write permission before calling a model', async t => {
  const remote = mockRemote(t, 'review_comment', { permissions: { issues: 'write', pull_requests: 'read' } });
  const msg = message(job('review_comment'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.modelInputs.length, 0);
  assert.equal(writes(remote, 'POST').length, 0);
  assert.match(remote.logs.join('\n'), /requires Pull requests write/);
  assert.deepEqual(remote.deadLetters, [job('review_comment')]);
  acknowledged(msg);
});

test('inline translation lookup follows pages and does not duplicate a source beyond its scan limit', async t => {
  await t.test('translation on a later page', async subtest => {
    const translation = { id: 500, body: `${markers.review_comment}\nOld`, in_reply_to_id: 77, user: { type: 'Bot' } };
    const remote = mockRemote(subtest, 'review_comment', { threadComments: [translation], threadPage: page =>
      page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1000, body: 'Unrelated' })) : [translation] });
    const msg = message(job('review_comment'));
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(writes(remote, 'POST').length, 0);
    assert.equal(writes(remote, 'PATCH').length, 1);
    acknowledged(msg);
  });
  await t.test('500 entries without finding the source', async subtest => {
    const remote = mockRemote(subtest, 'review_comment', { threadPage: () => Array.from({ length: 100 }, (_, index) => ({ id: index + 1000, body: 'Unrelated' })) });
    const msg = message(job('review_comment'));
    await app.queue({ messages: [msg] }, remote.bindings);
    assert.equal(writes(remote, 'POST').length, 0);
    assert.deepEqual(remote.deadLetters, [job('review_comment')]);
    acknowledged(msg);
  });
});

test('an Issue with a title and no description still produces a title translation', async t => {
  const remote = mockRemote(t, 'issue', { source: { body: null } });
  const msg = message(job('issue'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.deepEqual(remote.modelInputs, [{ title: 'Current issue title', body: '' }]);
  assert.equal(remote.comments.length, 1);
  assert.match(remote.comments[0].body, /译文标题/);
  acknowledged(msg);
});

test('edited sources update their corresponding translation and duplicate deliveries produce no additional writes', async t => {
  for (const kind of kinds) {
    await t.test(kind, async subtest => {
      const unrelated = '<!-- pr-translator-bot:v1 -->\nExisting PR translation';
      const remote = mockRemote(subtest, kind, { comments: [
        { id: 399, body: unrelated, user: { type: 'Bot' } },
        { id: 400, body: `${markers[kind]}\nOld translation`, user: { type: 'Bot' } },
        { id: 401, body: '<!-- pr-translator-bot:review:v1:660 -->\nAnother source', user: { type: 'Bot' } },
      ] });
      for (let iteration = 0; iteration < 2; iteration++) {
        const msg = message(job(kind));
        await app.queue({ messages: [msg] }, remote.bindings);
        acknowledged(msg);
      }
      assert.equal(writes(remote, 'POST').length, 0);
      assert.deepEqual(writes(remote, 'PATCH'), [{ path: '/repos/example-owner/demo/issues/comments/400', method: 'PATCH' }]);
      assert.equal(remote.comments[0].body, unrelated);
      assert.match(remote.comments[2].body, /Another source/);
      assert.match(remote.comments[1].body, /最新译文/);
    });
  }
});

test('deleted, wrong-repository and mismatched sources are acknowledged without model calls', async t => {
  const cases = [
    ['issue', 'deleted Issue', { sourceStatus: () => 404 }],
    ['issue', 'Issue endpoint represents a PR', { source: { pull_request: {} } }],
    ['issue_comment', 'deleted comment', { sourceStatus: () => 404 }],
    ['issue_comment', 'wrong Issue', { source: { issue_url: 'https://api.github.com/repos/example-owner/demo/issues/43' } }],
    ['issue_comment', 'wrong origin', { source: { issue_url: 'https://untrusted.example/repos/example-owner/demo/issues/42' } }],
    ['review', 'deleted Review', { sourceStatus: () => 404 }],
    ['review', 'pending Review', { source: { state: 'PENDING' } }],
    ['review', 'mismatched Review id', { source: { id: 67 } }],
    ['review', 'wrong Review association', { source: { html_url: 'https://github.com/example-owner/other/pull/42#pullrequestreview-66' } }],
    ['review_comment', 'deleted inline comment', { sourceStatus: () => 404 }],
    ['review_comment', 'wrong PR', { source: { pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/43' } }],
    ['review_comment', 'wrong repository', { source: { pull_request_url: 'https://api.github.com/repos/example-owner/other/pulls/42' } }],
    ['review_comment', 'wrong inline comment id', { source: { id: 78 } }],
  ];
  for (const [kind, name, options] of cases) {
    await t.test(name, async subtest => {
      const remote = mockRemote(subtest, kind, options);
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 0);
      assert.equal(writes(remote, 'POST').length, 0);
      acknowledged(msg);
      assert.deepEqual(remote.deadLetters, []);
      assert.doesNotMatch(remote.logs.join('\n'), /Private source error detail/);
    });
  }
});

test('empty and generated sources are suppressed without excluding independent bots', async t => {
  for (const kind of ['issue_comment', 'review', 'review_comment']) {
    for (const source of [
      { body: ' \n\t' }, { body: markers.issue }, { body: markers.review_comment },
      { performed_via_github_app: { id: Number(env.GITHUB_APP_ID) } },
    ]) {
      await t.test(`${kind}: ${JSON.stringify(source)}`, async subtest => {
        const remote = mockRemote(subtest, kind, { source });
        const msg = message(job(kind));
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(remote.modelInputs.length, 0);
        assert.equal(writes(remote, 'POST').length, 0);
        acknowledged(msg);
      });
    }
    await t.test(`${kind}: another bot with coincident user id`, async subtest => {
      const remote = mockRemote(subtest, kind, { source: {
        user: { id: Number(env.GITHUB_APP_ID), type: 'Bot', login: 'another-bot[bot]' },
        performed_via_github_app: { id: 987654 },
      } });
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 1);
      assert.equal(writes(remote, 'POST').length, 1);
      acknowledged(msg);
    });
  }
});

test('repo privacy and closed containers are checked both before translation and immediately before publishing', async t => {
  for (const kind of kinds) {
    for (const during of [false, true]) {
      await t.test(`${kind}: private, changed during model=${during}`, async subtest => {
        const remote = mockRemote(subtest, kind, { repo: count => ({ private: !during || count > 1 }) });
        const msg = message(job(kind));
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(remote.modelInputs.length, during ? 1 : 0);
        assert.equal(writes(remote, 'POST').length, 0);
        acknowledged(msg);
      });
      await t.test(`${kind}: closed, changed during model=${during}`, async subtest => {
        const options = kind === 'issue'
          ? { source: { state: during ? 'open' : 'closed' }, model: current => {
            current.source.state = 'closed'; return geminiAnswer();
          } }
          : { container: count => ({ state: !during || count > 1 ? 'closed' : 'open', base: { repo: { private: false } } }) };
        const remote = mockRemote(subtest, kind, options);
        const msg = message(job(kind));
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(remote.modelInputs.length, during ? 1 : 0);
        assert.equal(writes(remote, 'POST').length, 0);
        acknowledged(msg);
      });
    }
  }
});

test('source edits during translation retry fresh content and never publish the stale result', async t => {
  for (const kind of kinds) {
    await t.test(kind, async subtest => {
      let editOnce = true;
      const remote = mockRemote(subtest, kind, { model: current => {
        if (editOnce) {
          editOnce = false;
          current.source.body = 'Newest source after edit';
          if (kind === 'issue') current.source.title = 'Newest issue title';
          return geminiAnswer('Stale result must never be posted');
        }
        return geminiAnswer('编辑后的最新译文。');
      } });
      const first = message(job(kind));
      await app.queue({ messages: [first] }, remote.bindings);
      assert.equal(first.state.acknowledgements, 0);
      assert.deepEqual(first.state.retries, [{ delaySeconds: 30 }]);
      assert.equal(writes(remote, 'POST').length, 0);
      assert.deepEqual(remote.deadLetters, []);
      const retry = message(job(kind), 2);
      await app.queue({ messages: [retry] }, remote.bindings);
      assert.equal(remote.modelInputs[1].body, 'Newest source after edit');
      if (kind === 'issue') assert.equal(remote.modelInputs[1].title, 'Newest issue title');
      const translation = kind === 'review_comment' ? remote.threadComments[0] : remote.comments[0];
      assert.match(translation.body, /编辑后的最新译文/);
      assert.doesNotMatch(translation.body, /Stale result/);
      acknowledged(retry);
    });
  }
});

test('an Issue title edit alone invalidates the result even when the description is unchanged', async t => {
  const remote = mockRemote(t, 'issue', { model: current => {
    current.source.title = 'Changed issue title';
    return geminiAnswer('Body result');
  } });
  const msg = message(job('issue'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
  assert.equal(msg.state.acknowledgements, 0);
  assert.equal(writes(remote, 'POST').length, 0);
});

test('source removal, ownership change and reassociation during translation prevent publication', async t => {
  for (const kind of ['issue_comment', 'review', 'review_comment']) {
    for (const change of ['deleted', 'own App', 'wrong source id']) {
      await t.test(`${kind}: ${change}`, async subtest => {
        const remote = mockRemote(subtest, kind, {
          sourceStatus: read => change === 'deleted' && read > 1 ? 404 : 200,
          model: current => {
            if (change === 'own App') current.source.performed_via_github_app = { id: Number(env.GITHUB_APP_ID) };
            if (change === 'wrong source id') current.source.id += 1;
            return geminiAnswer();
          },
        });
        const msg = message(job(kind));
        await app.queue({ messages: [msg] }, remote.bindings);
        assert.equal(remote.modelInputs.length, 1);
        assert.equal(writes(remote, 'POST').length, 0);
        acknowledged(msg);
      });
    }
  }
});

test('invalid version-three queue jobs are discarded without copying extra content into the dead-letter queue', async t => {
  const remote = mockRemote(t, 'review');
  const invalid = [
    { ...job('issue'), sourceId: 55 }, { ...job('review'), sourceId: 0 },
    { ...job('review_comment'), sourceId: '77' }, { ...job('review'), kind: 'pull_request_review' },
    { ...job('review'), body: 'Private queue text' }, { ...job('review'), installationId: '123' },
  ];
  const messages = invalid.map(value => message(value));
  await app.queue({ messages }, remote.bindings);
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(remote.deadLetters, []);
  for (const msg of messages) acknowledged(msg);
  assert.doesNotMatch(remote.logs.join('\n'), /Private queue text/);
});

test('read-only installations fail before sending source text to a translation provider', async t => {
  const remote = mockRemote(t, 'review', { permissions: { issues: 'read', pull_requests: 'read' } });
  const msg = message(job('review'));
  await app.queue({ messages: [msg] }, remote.bindings);
  assert.equal(remote.modelInputs.length, 0);
  assert.equal(writes(remote, 'POST').length, 0);
  acknowledged(msg);
  assert.deepEqual(remote.deadLetters, [job('review')]);
});

test('missing or malformed repository visibility retries without sending content to a provider', async t => {
  for (const [kind, repository] of [
    ...kinds.map(kind => [kind, {}]),
    ['issue', { private: 'false' }],
  ]) {
    await t.test(`${kind}: ${JSON.stringify(repository)}`, async subtest => {
      const remote = mockRemote(subtest, kind, { repo: () => repository });
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 0);
      assert.equal(writes(remote, 'POST').length, 0);
      assert.equal(msg.state.acknowledgements, 0);
      assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
      assert.deepEqual(remote.deadLetters, []);
    });
  }
});

test('an unexpected Issue or PR number in the API response is skipped before translation', async t => {
  for (const kind of kinds) {
    await t.test(kind, async subtest => {
      const options = kind === 'issue' ? { source: { number: 43 } }
        : { container: () => ({ number: 43, state: 'open', base: { repo: { private: false } } }) };
      const remote = mockRemote(subtest, kind, options);
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 0);
      assert.equal(writes(remote, 'POST').length, 0);
      acknowledged(msg);
      assert.deepEqual(remote.deadLetters, []);
    });
  }
});

test('leading whitespace cannot cause generated discussion or review text to be translated recursively', async t => {
  for (const kind of ['issue_comment', 'review', 'review_comment']) {
    await t.test(kind, async subtest => {
      const remote = mockRemote(subtest, kind, { source: { body: ` \n\t${markers[kind]}\nGenerated content` } });
      const msg = message(job(kind));
      await app.queue({ messages: [msg] }, remote.bindings);
      assert.equal(remote.modelInputs.length, 0);
      assert.equal(writes(remote, 'POST').length, 0);
      acknowledged(msg);
      assert.deepEqual(remote.deadLetters, []);
    });
  }
});
