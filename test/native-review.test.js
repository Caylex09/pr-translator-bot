import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import app from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const env = {
  GITHUB_APP_ID: '123456', GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: 'native-review-test-webhook-secret',
  GEMINI_API_KEY: 'native-review-test-api-key', GEMINI_MODEL: 'test-model',
  TARGET_OWNER: 'example-owner', TRANSLATION_TIMEOUT_MS: '60000', ALLOW_PRIVATE: 'false',
};
const prefix = '/repos/example-owner/demo';
const pull = `${prefix}/pulls/42`;
const commit = 'a'.repeat(40);
const sourceUrl = `https://api.github.com${pull}`;
const sourceReview = {
  id: 66, body: 'The review found two important cases that need to be corrected before merging.',
  state: 'CHANGES_REQUESTED', commit_id: commit,
  html_url: 'https://github.com/example-owner/demo/pull/42#pullrequestreview-66',
  user: { type: 'Bot', login: 'chatgpt-codex-connector[bot]' },
};
const root = (id = 77, overrides = {}) => ({
  id, body: `**P1** Fix case ${id}.\n\nKeep \`calculate()\` and this Markdown.`,
  pull_request_url: sourceUrl, pull_request_review_id: 66,
  path: id === 77 ? 'src/first.js' : 'src/second.js',
  commit_id: 'b'.repeat(40), original_commit_id: commit,
  line: null, original_line: id === 77 ? 12 : 20,
  start_line: null, original_start_line: id === 77 ? 10 : null,
  side: id === 77 ? 'RIGHT' : 'LEFT', start_side: id === 77 ? 'RIGHT' : null,
  html_url: `https://github.com/example-owner/demo/pull/42#discussion_r${id}`,
  user: { type: 'Bot', login: 'chatgpt-codex-connector[bot]' }, ...overrides,
});
const job = (kind = 'review', sourceId = 66) => ({
  version: 4, kind, installationId: 123,
  owner: 'example-owner', repo: 'demo', number: 42, sourceId,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const gemini = value => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });

// The Review-scoped endpoint uses the compact/legacy comment representation.
// Line ranges, side and parent-thread IDs come from the PR-scoped endpoint.
const scopedComment = source => ({ id: source.id, body: source.body, user: source.user,
  pull_request_review_id: source.pull_request_review_id, pull_request_url: source.pull_request_url,
  path: source.path, commit_id: source.commit_id, original_commit_id: source.original_commit_id,
  position: 1, original_position: 1 });

function message(body, attempts = 1) {
  const state = { acknowledgements: 0, retries: [] };
  return { body, attempts, state, ack() { state.acknowledgements++; },
    retry(value) { state.retries.push(value); } };
}

function remote(t, options = {}) {
  const state = {
    calls: [], modelInputs: [], logs: [], deadLetters: [],
    review: structuredClone({ ...sourceReview, ...options.review }),
    roots: structuredClone(options.roots || [root(), root(78)]),
    replies: structuredClone(options.replies || []),
    botReviews: structuredClone(options.botReviews || []), botComments: [],
    nextReviewId: 1000, nextCommentId: 2000,
    private: false, closed: false, repositoryReads: 0,
  };
  for (const level of ['info', 'warn', 'error']) t.mock.method(console, level, (...args) => state.logs.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ path, method, ...(body ? { body } : {}) });
    if (parsed.hostname === 'generativelanguage.googleapis.com') {
      const input = body.contents[0].parts[0].text;
      const value = JSON.parse(input.slice(input.indexOf('\n') + 1));
      state.modelInputs.push(value);
      if (options.model) await options.model(state, value);
      return gemini(value.items ? { items: value.items.map(item => ({
        id: item.id, sourceLanguage: 'en', title: '',
        body: `**条目 ${item.id} 的译文**\n\n请修复该问题，保留 \`calculate()\`。`,
      })).reverse() } : { sourceLanguage: 'en', title: '', body: '这是后续回复的译文。' });
    }
    assert.equal(parsed.hostname, 'api.github.com');
    assert.equal(init.redirect, 'manual');
    if (path === '/app/installations/123/access_tokens') {
      assert.equal(method, 'POST');
      const [header, claims, signature] = new Headers(init.headers).get('authorization').slice(7).split('.');
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, env.GITHUB_APP_ID);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
        Buffer.from(signature, 'base64url')), true);
      return json({ token: 'native-review-test-installation-token',
        permissions: Object.hasOwn(options, 'permissions') ? options.permissions : { issues: 'write', pull_requests: 'write' } });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer native-review-test-installation-token');
    if (path === prefix) {
      assert.equal(method, 'GET');
      state.repositoryReads++;
      if (options.repository) await options.repository(state);
      return json({ private: state.private });
    }
    if (path === pull) {
      assert.equal(method, 'GET');
      return json({ number: 42, state: state.closed ? 'closed' : 'open', base: { repo: { private: state.private } } });
    }
    if (path === `${pull}/reviews/66`) {
      assert.equal(method, 'GET', 'The original Review must never be edited');
      return json(state.review);
    }
    if (path === `${pull}/reviews/66/comments`) {
      assert.equal(method, 'GET');
      return json(state.roots.map(scopedComment));
    }
    if (path === `${pull}/reviews`) {
      if (method === 'GET') return json([state.review, ...state.botReviews]);
      assert.equal(method, 'POST');
      const created = { id: state.nextReviewId++, body: body.body, state: 'COMMENTED',
        commit_id: body.commit_id, user: { type: 'Bot', login: 'pr-translator[bot]' } };
      state.botReviews.push(created);
      for (const source of body.comments) state.botComments.push({ ...source, id: state.nextCommentId++,
        pull_request_review_id: created.id, pull_request_url: sourceUrl,
        user: { type: 'Bot', login: 'pr-translator[bot]' } });
      return json(created, 201);
    }
    if (/\/reviews\/\d+\/comments$/.test(path)) {
      assert.equal(method, 'GET');
      const reviewId = Number(path.split('/').at(-2));
      return json(options.reviewComments ? options.reviewComments(reviewId, state)
        : state.botComments.filter(comment => comment.pull_request_review_id === reviewId).map(scopedComment));
    }
    if (/\/reviews\/\d+$/.test(path)) {
      assert.equal(method, 'PUT');
      const review = state.botReviews.find(value => value.id === Number(path.split('/').at(-1)));
      assert.ok(review);
      review.body = body.body;
      return json(review);
    }
    if (path === `${pull}/comments`) {
      assert.equal(method, 'GET');
      return json(options.prComments ? options.prComments(Number(parsed.searchParams.get('page') || 1), state)
        : [...state.roots, ...state.replies, ...state.botComments]);
    }
    if (/\/pulls\/comments\/\d+$/.test(path)) {
      const id = Number(path.split('/').at(-1));
      if (method === 'GET') return json([...state.roots, ...state.replies, ...state.botComments]
        .find(comment => comment.id === id) || { message: 'Not found' },
        [...state.roots, ...state.replies, ...state.botComments].some(comment => comment.id === id) ? 200 : 404);
      assert.equal(method, 'PATCH');
      const comment = state.botComments.find(value => value.id === id);
      assert.ok(comment, 'Only the bot own inline comments may be edited');
      comment.body = body.body;
      return json(comment);
    }
    if (/\/comments\/\d+\/replies$/.test(path)) {
      assert.equal(method, 'POST');
      const rootId = Number(path.split('/').at(-2));
      const ownRoot = state.botComments.find(value => value.id === rootId);
      assert.ok(ownRoot, 'Translated replies must attach to the bot own root');
      const comment = { id: state.nextCommentId++, body: body.body, in_reply_to_id: rootId,
        pull_request_review_id: ownRoot.pull_request_review_id, user: { type: 'Bot' }, pull_request_url: sourceUrl };
      state.botComments.push(comment);
      return json(comment, 201);
    }
    throw new Error(`Unexpected mocked endpoint ${method} ${path}`);
  });
  state.bindings = { ...env, TRANSLATION_DLQ: { send: async value => state.deadLetters.push(value) } };
  return state;
}

const githubWrites = state => state.calls.filter(call => call.path.startsWith(prefix) && call.method !== 'GET');
const reviewCreates = state => state.calls.filter(call => call.path === `${pull}/reviews` && call.method === 'POST');
async function consume(state, value = job()) {
  const msg = message(value);
  await app.queue({ messages: [msg] }, state.bindings);
  return msg;
}
function ack(msg) {
  assert.equal(msg.state.acknowledgements, 1);
  assert.deepEqual(msg.state.retries, []);
}

test('native review copies one submitted Review with its summary and original inline coordinates', async t => {
  const state = remote(t);
  ack(await consume(state));
  assert.equal(state.modelInputs.length, 1);
  assert.deepEqual(state.modelInputs[0].items.map(item => item.id), ['review', '77', '78']);
  assert.equal(reviewCreates(state).length, 1);
  const { body } = reviewCreates(state)[0];
  assert.equal(body.event, 'COMMENT');
  assert.equal(body.commit_id, commit);
  assert.match(body.body, /^<!-- pr-translator-bot:review:v2:66 -->\n<!-- pr-translator-bot:source:v1:[a-f0-9]{64} -->/);
  assert.match(body.body, /条目 review 的译文/);
  assert.deepEqual(body.comments.map(({ body: unused, ...coordinates }) => coordinates), [
    { path: 'src/first.js', line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT' },
    { path: 'src/second.js', line: 20, side: 'LEFT' },
  ]);
  for (const [index, id] of [77, 78].entries()) {
    assert.match(body.comments[index].body, new RegExp(`^<!-- pr-translator-bot:review-comment:v2:${id} -->`));
    assert.match(body.comments[index].body, new RegExp(`条目 ${id} 的译文`));
    assert.match(body.comments[index].body, /`calculate\(\)`/);
  }
  assert.deepEqual(githubWrites(state).map(call => call.path), [`${pull}/reviews`]);
});

test('review and root webhook jobs coalesce and duplicate deliveries skip models and writes', async t => {
  const state = remote(t);
  ack(await consume(state, job('review_comment', 77)));
  const calls = state.modelInputs.length;
  for (const value of [job(), job('review_comment', 77), job('review_comment', 78)]) ack(await consume(state, value));
  assert.equal(state.modelInputs.length, calls);
  assert.equal(reviewCreates(state).length, 1);
  assert.equal(githubWrites(state).length, 1);
});

test('an empty source Review summary still creates one Review containing both inline translations', async t => {
  const state = remote(t, { review: { body: '' } });
  ack(await consume(state));
  assert.deepEqual(state.modelInputs[0].items.map(item => item.id), ['77', '78']);
  assert.equal(reviewCreates(state).length, 1);
  assert.match(state.botReviews[0].body, /Inline translations below/);
  assert.equal(state.botComments.length, 2);
});

test('editing the source Review and a root updates the same bot Review and inline comment', async t => {
  const state = remote(t);
  ack(await consume(state));
  const ownReviewId = state.botReviews[0].id;
  const ownCommentId = state.botComments[0].id;
  state.review.body = 'The review summary was changed to describe another issue that should be fixed.';
  state.roots[0].body = '**P1** The revised root comment explains a new concern.';
  ack(await consume(state, job('review_comment', 77)));
  assert.deepEqual(state.modelInputs[1].items.map(item => item.id), ['review', '77']);
  assert.equal(reviewCreates(state).length, 1);
  assert.ok(githubWrites(state).some(call => call.method === 'PUT' && call.path === `${pull}/reviews/${ownReviewId}`));
  assert.ok(githubWrites(state).some(call => call.method === 'PATCH' && call.path === `${prefix}/pulls/comments/${ownCommentId}`));
  const count = githubWrites(state).length;
  ack(await consume(state));
  assert.equal(githubWrites(state).length, count);
  assert.equal(state.modelInputs.length, 2);
});

test('source thread replies translate below the bot own root and later edits reuse that reply', async t => {
  const reply = root(79, { body: 'The follow-up explains why this can be safely fixed now.', in_reply_to_id: 77,
    pull_request_review_id: 67, user: { type: 'User', login: 'contributor' } });
  const state = remote(t, { replies: [reply] });
  ack(await consume(state, job('review_comment', 79)));
  assert.equal(state.modelInputs.length, 2);
  assert.equal(reviewCreates(state).length, 1);
  const ownRoot = state.botComments.find(comment => comment.body.startsWith('<!-- pr-translator-bot:review-comment:v2:77 -->'));
  const ownReply = state.botComments.find(comment => comment.body.startsWith('<!-- pr-translator-bot:review-reply:v1:79 -->'));
  assert.equal(ownReply.in_reply_to_id, ownRoot.id);
  assert.notEqual(ownReply.in_reply_to_id, 77);
  assert.equal(ownReply.pull_request_review_id, state.botReviews[0].id);
  ack(await consume(state, job('review_comment', 79)));
  assert.equal(state.modelInputs.length, 2);
  state.replies[0].body += ' An additional explanation was provided.';
  ack(await consume(state, job('review_comment', 79)));
  assert.equal(state.modelInputs.length, 3);
  assert.ok(githubWrites(state).some(call => call.method === 'PATCH' && call.path === `${prefix}/pulls/comments/${ownReply.id}`));
  assert.equal(state.botComments.filter(comment => comment.in_reply_to_id === ownRoot.id).length, 1);
});

test('a compact reply-only Review is recognized from full parent metadata and creates no root copy', async t => {
  const state = remote(t, { review: { body: '' }, roots: [root(79, { in_reply_to_id: 77 })] });
  ack(await consume(state));
  assert.equal(state.modelInputs.length, 0);
  assert.equal(state.botReviews.length, 0);
  assert.deepEqual(state.deadLetters, []);
});

test('a scoped comment missing from the full list retries and recovers without posting an incomplete Review', async t => {
  let missing = true;
  const state = remote(t, { prComments: (_page, value) => missing ? [] : [...value.roots, ...value.botComments] });
  const first = await consume(state);
  assert.equal(first.state.acknowledgements, 0);
  assert.deepEqual(first.state.retries, [{ delaySeconds: 30 }]);
  assert.equal(state.modelInputs.length, 0);
  assert.equal(state.botReviews.length, 0);
  missing = false;
  ack(await consume(state));
  assert.equal(state.botReviews.length, 1);
  assert.equal(state.botComments.length, 2);
});

test('full review metadata is looked up across PR comment pages', async t => {
  const filler = Array.from({ length: 100 }, (_, index) => ({ id: 5000 + index }));
  const state = remote(t, { prComments: (page, value) => page === 1 ? filler : [...value.roots, ...value.botComments] });
  ack(await consume(state));
  assert.equal(state.botReviews.length, 1);
  assert.equal(state.botComments[0].line, 12);
  assert.equal(state.botComments[0].side, 'RIGHT');
});

test('full metadata association mismatches cannot publish another Review or PR content', async t => {
  for (const change of [{ pull_request_review_id: 67 }, { pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/43' }]) {
    await t.test(JSON.stringify(change), async sub => {
      const state = remote(sub, { prComments: (_page, value) => value.roots.map(source => ({ ...source, ...change })) });
      ack(await consume(state));
      assert.equal(state.modelInputs.length, 0);
      assert.equal(state.botReviews.length, 0);
      assert.equal(state.deadLetters.length, 1);
    });
  }
});

test('metadata lookup overflow stops before translation or writes', async t => {
  const state = remote(t, { prComments: () => Array.from({ length: 100 }, (_, index) => ({ id: 5000 + index })) });
  ack(await consume(state));
  assert.equal(state.modelInputs.length, 0);
  assert.equal(state.botReviews.length, 0);
  assert.equal(state.deadLetters.length, 1);
});

test('a delayed new source root uses an explicitly linked supplement Review without duplication', async t => {
  const state = remote(t, { roots: [root()] });
  ack(await consume(state));
  state.roots.push(root(78));
  const callsBeforeSupplement = state.calls.length;
  ack(await consume(state, job('review_comment', 78)));
  assert.deepEqual(state.modelInputs[1].items.map(item => item.id), ['78']);
  assert.equal(reviewCreates(state).length, 2);
  const supplement = reviewCreates(state)[1].body;
  assert.match(supplement.body, /^<!-- pr-translator-bot:review-supplement:v1:66:[a-f0-9]{16} -->/);
  assert.equal(supplement.comments.length, 1);
  assert.match(supplement.comments[0].body, /review-comment:v2:78/);
  assert.equal(supplement.commit_id, commit);
  assert.equal(state.calls.slice(callsBeforeSupplement).filter(call => call.method === 'GET' && call.path === `${pull}/comments`).length, 4,
    'Native Review and its supplement share one full-comment index per lookup');
  ack(await consume(state));
  ack(await consume(state, job('review_comment', 78)));
  assert.equal(reviewCreates(state).length, 2);
  assert.equal(state.modelInputs.length, 2);
});

test('source changes during batch translation retry current text and publish no stale Review', async t => {
  const state = remote(t, { model(value) { value.roots[0].body += ' Actual source edit during the model call.'; } });
  const msg = await consume(state);
  assert.equal(msg.state.acknowledgements, 0);
  assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
  assert.deepEqual(githubWrites(state), []);
  assert.deepEqual(state.deadLetters, []);
});

test('native reviews verify Pull requests write permission before reading or translating source text', async t => {
  for (const permissions of [{ issues: 'write', pull_requests: 'read' }, { issues: 'write' }, null]) {
    await t.test(JSON.stringify(permissions), async sub => {
      const state = remote(sub, { permissions });
      const msg = await consume(state);
      assert.equal(state.modelInputs.length, 0);
      assert.equal(state.repositoryReads, 0);
      assert.deepEqual(githubWrites(state), []);
      if (permissions === null) assert.deepEqual(msg.state.retries, [{ delaySeconds: 30 }]);
      else { ack(msg); assert.equal(state.deadLetters.length, 1); }
    });
  }
});

test('native reviews skip pending, own translations, wrong PR association, and empty sources', async t => {
  for (const [name, options] of [
    ['pending', { review: { state: 'PENDING' } }],
    ['own marker', { review: { body: '<!-- pr-translator-bot:review:v2:66 --> own translation' } }],
    ['own App', { review: { performed_via_github_app: { id: Number(env.GITHUB_APP_ID) } } }],
    ['wrong PR', { review: { html_url: 'https://github.com/example-owner/demo/pull/43#pullrequestreview-66' } }],
    ['wrong ID', { review: { id: 999 } }],
    ['empty summary and no roots', { review: { body: '' }, roots: [] }],
  ]) {
    await t.test(name, async sub => {
      const state = remote(sub, options);
      ack(await consume(state));
      assert.equal(state.modelInputs.length, 0);
      assert.deepEqual(githubWrites(state), []);
    });
  }
});

test('private or closed PRs skip native Review and inline jobs before model calls', async t => {
  for (const kind of ['review', 'review_comment']) for (const reason of ['private', 'closed']) {
    await t.test(`${kind} ${reason}`, async sub => {
      const state = remote(sub);
      state[reason] = true;
      ack(await consume(state, job(kind, kind === 'review' ? 66 : 77)));
      assert.equal(state.modelInputs.length, 0);
      assert.deepEqual(githubWrites(state), []);
    });
  }
});

test('repository privacy is checked again after translation and prevents native Review publication', async t => {
  const state = remote(t, { model(value) { value.private = true; } });
  ack(await consume(state));
  assert.equal(state.modelInputs.length, 1);
  assert.deepEqual(githubWrites(state), []);
});

test('invalid original commit or coordinates never produce misplaced inline comments', async t => {
  for (const [name, change] of [
    ['different original commit', { original_commit_id: 'c'.repeat(40) }],
    ['missing original line', { original_line: null }],
    ['wrong side', { side: 'MIDDLE' }],
    ['empty path', { path: '' }],
    ['reversed original range', { original_start_line: 13 }],
    ['invalid range side', { start_side: 'MIDDLE' }],
  ]) {
    await t.test(name, async sub => {
      const state = remote(sub, { roots: [root(77, change)] });
      ack(await consume(state));
      assert.deepEqual(githubWrites(state), []);
      assert.equal(state.deadLetters.length, 1);
    });
  }
});

test('an existing translated Review must belong to the same PR, reviewed commit, and App', async t => {
  for (const [name, change] of [
    ['another commit', { commit_id: 'c'.repeat(40) }],
    ['another PR', { html_url: 'https://github.com/example-owner/demo/pull/43#pullrequestreview-1000' }],
    ['another App', { performed_via_github_app: { id: 999 } }],
  ]) {
    await t.test(name, async sub => {
      const state = remote(sub);
      ack(await consume(state));
      Object.assign(state.botReviews[0], change);
      const oldWrites = githubWrites(state).length;
      ack(await consume(state));
      assert.equal(state.modelInputs.length, 1);
      assert.equal(githubWrites(state).length, oldWrites);
      assert.equal(state.deadLetters.length, 1);
    });
  }
});

test('an existing translated root must belong to the bot Review, original PR, and App', async t => {
  for (const [name, change] of [
    ['another review', { pull_request_review_id: 999 }],
    ['another PR', { pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/43' }],
    ['another App', { performed_via_github_app: { id: 999 } }],
  ]) {
    await t.test(name, async sub => {
      const state = remote(sub, { reviewComments: (_reviewId, value) => value.botComments });
      ack(await consume(state));
      Object.assign(state.botComments[0], change);
      const oldWrites = githubWrites(state).length;
      ack(await consume(state));
      assert.equal(state.modelInputs.length, 1);
      assert.equal(githubWrites(state).length, oldWrites);
      assert.equal(state.deadLetters.length, 1);
    });
  }
});

test('source root associations are checked before model calls', async t => {
  for (const change of [{ pull_request_review_id: 67 },
    { pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/43' }]) {
    await t.test(JSON.stringify(change), async sub => {
      const state = remote(sub, { roots: [root(77, change)] });
      ack(await consume(state));
      assert.equal(state.modelInputs.length, 0);
      assert.deepEqual(githubWrites(state), []);
      assert.equal(state.deadLetters.length, 1);
    });
  }
});

test('new Review and inline webhooks queue version-four identifiers only', async t => {
  for (const [event, kind, action] of [
    ['pull_request_review', 'review', 'submitted'],
    ['pull_request_review', 'review', 'edited'],
    ['pull_request_review_comment', 'review_comment', 'created'],
    ['pull_request_review_comment', 'review_comment', 'edited'],
  ]) {
    await t.test(`${event} ${action}`, async () => {
      const source = kind === 'review' ? sourceReview : root();
      const payload = { action, installation: { id: 123 },
        repository: { full_name: 'example-owner/demo', name: 'demo', owner: { login: 'example-owner' }, private: false },
        pull_request: { number: 42 }, [kind === 'review' ? 'review' : 'comment']: source };
      const body = JSON.stringify(payload);
      const sent = [];
      const result = await app.fetch(new Request('https://example.workers.dev/webhook', {
        method: 'POST', body, headers: { 'X-GitHub-Event': event,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}` },
      }), { ...env, TRANSLATION_QUEUE: { send: async value => sent.push(value) } },
      { waitUntil() { assert.fail('Queued webhooks must not call translation models'); } });
      assert.equal(result.status, 202);
      assert.deepEqual(sent, [job(kind, source.id)]);
      assert.equal(JSON.stringify(sent).includes(source.body), false);
    });
  }
});
