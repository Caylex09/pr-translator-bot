import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';

async function nativeQueueScenario(isComment = false, contentKind) {
  const bodyOnly = isComment || (contentKind && contentKind !== 'issue');
  const issueContainer = contentKind === 'issue' || contentKind === 'issue_comment';
  const sourceId = contentKind === 'review' ? 66 : contentKind === 'review_comment' ? 77 : 55;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const secret = 'queue-runtime-webhook-secret-not-production';
  const apiKey = 'queue-runtime-gemini-key-not-production';
  const token = 'queue-runtime-installation-token';
  const originalComment = '<!-- codex-pull-request-review-summary -->\n\n## Review Summary\n\nCompleted for `parseTable()`. [Review](https://example.com/review)\n<relative-time datetime="2026-10-13T11:18:19Z">2026-10-13T11:18:19Z</relative-time>';
  const translation = bodyOnly
    ? { sourceLanguage: 'en', title: '', body: '## 审查汇总\n\n已完成 `parseTable()` 的审查。' }
    : { sourceLanguage: 'zh', title: 'Fix pagination', body: 'Keep Markdown intact.' };
  const calls = [];
  let postedComment;
  let resolvePosted;
  let rejectPosted;
  const commentPosted = new Promise((resolve, reject) => {
    resolvePosted = resolve;
    rejectPosted = reject;
  });
  // The native consumer may start before dispatchFetch finishes returning.
  // Keep an early mock failure handled until the assertion below awaits it.
  commentPosted.catch(() => {});
  // A queue consumer runs asynchronously after dispatchFetch. Surface mock
  // assertion failures immediately instead of waiting for the queue's retries.
  const outbound = async request => {
    try {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.hostname}${url.pathname}`);
      if (url.hostname === 'api.github.com') {
        if (url.pathname === '/app/installations/123/access_tokens') {
          assert.equal(request.method, 'POST');
          const jwt = request.headers.get('authorization').replace(/^Bearer /, '');
          const parts = jwt.split('.');
          assert.equal(parts.length, 3);
          assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).iss, '456');
          assert.equal(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
            publicKey, Buffer.from(parts[2], 'base64url')), true);
          return Response.json({ token, permissions: { issues: 'write', pull_requests: 'read' } });
        }
        assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
        if (contentKind && url.pathname === '/repos/example-owner/demo') {
          assert.equal(request.method, 'GET');
          return Response.json({ private: false });
        }
        if (issueContainer && url.pathname === '/repos/example-owner/demo/issues/42') {
          assert.equal(request.method, 'GET');
          return Response.json({ number: 42, state: 'open', title: '修复分页', body: '保留 Markdown。' });
        }
        if (url.pathname === '/repos/example-owner/demo/pulls/42') {
          assert.equal(request.method, 'GET');
          return Response.json({ state: 'open', title: '修复分页', body: '保留 Markdown。',
            base: { repo: { private: false } } });
        }
        if ((isComment || contentKind === 'issue_comment') && url.pathname === '/repos/example-owner/demo/issues/comments/55') {
          assert.equal(request.method, 'GET');
          return Response.json({ id: 55, body: originalComment,
            issue_url: 'https://api.github.com/repos/example-owner/demo/issues/42',
            html_url: 'https://unexpected.invalid/not-the-source',
            user: { login: 'another-review-service[bot]', type: 'Bot' },
            performed_via_github_app: { id: 999 } });
        }
        if (contentKind === 'review' && url.pathname === '/repos/example-owner/demo/pulls/42/reviews/66') {
          return Response.json({ id: 66, state: 'COMMENTED', body: originalComment,
            html_url: 'https://github.com/example-owner/demo/pull/42#pullrequestreview-66' });
        }
        if (contentKind === 'review_comment' && url.pathname === '/repos/example-owner/demo/pulls/comments/77') {
          return Response.json({ id: 77, body: originalComment,
            pull_request_url: 'https://api.github.com/repos/example-owner/demo/pulls/42' });
        }
        if (url.pathname === '/repos/example-owner/demo/issues/42/comments') {
          if (request.method === 'GET') return Response.json([]);
          assert.equal(request.method, 'POST');
          postedComment = (await request.json()).body;
          resolvePosted();
          return Response.json({ id: 100, body: postedComment, user: { type: 'Bot' } }, { status: 201 });
        }
      }
      if (url.hostname === 'generativelanguage.googleapis.com') {
        assert.equal(request.method, 'POST');
        assert.equal(url.pathname, '/v1beta/models/runtime-model:generateContent');
        assert.equal(request.headers.get('x-goog-api-key'), apiKey);
        const data = await request.json();
        const contents = JSON.stringify(data.contents);
        if (bodyOnly) {
          const input = JSON.parse(data.contents[0].parts[0].text.replace(/^PR_DATA_JSON:\n/, ''));
          assert.equal(input.title, '');
          assert.equal(input.body, originalComment);
          assert.match(JSON.stringify(data.systemInstruction), /HTML tags and attributes/);
        } else {
          assert.match(contents, /修复分页/);
          assert.match(contents, /保留 Markdown/);
        }
        assert.doesNotMatch(contents, /stale webhook text/);
        return Response.json({ candidates: [{ finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(translation) }] } }] });
      }
      throw new Error(`Unexpected mocked outbound request: ${request.method} ${url.hostname}${url.pathname}`);
    } catch (error) {
      rejectPosted(error);
      return Response.json({ error: 'Test assertion failed' }, { status: 500 });
    }
  };
  const [indexModule, translationModule, githubModule, contentModule] = await Promise.all([
    readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/translation.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/github.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/content.js', import.meta.url), 'utf8'),
  ]);
  const variables = {
    GITHUB_APP_ID: '456', GITHUB_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: secret,
    GEMINI_API_KEY: apiKey, GEMINI_MODEL: 'runtime-model', TARGET_OWNER: 'example-owner',
    ALLOW_PRIVATE: 'false', TRANSLATION_TIMEOUT_MS: '60000',
  };
  const mf = new Miniflare({
    host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
    workers: [{
      config: {
        name: 'translation-queue-runtime-test', compatibilityDate: '2026-10-13',
        env: {
          ...Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, { type: 'text', value }])),
          TRANSLATION_QUEUE: { type: 'queue', name: 'pr-translator-jobs' },
          TRANSLATION_DLQ: { type: 'queue', name: 'pr-translator-failed' },
        },
        triggers: [{ type: 'queue', name: 'pr-translator-jobs', maxBatchSize: 1,
          maxBatchTimeout: 0, maxRetries: 0, deadLetterQueue: 'pr-translator-failed' }],
        manifest: { mainModule: 'index.js', modules: {
          'index.js': { type: 'esm', contents: indexModule },
          'translation.js': { type: 'esm', contents: translationModule },
          'github.js': { type: 'esm', contents: githubModule },
          'content.js': { type: 'esm', contents: contentModule },
        } },
      },
      dev: { outboundService: { type: 'fetcher', handler: outbound } },
    }],
  });
  let timer;
  try {
    const event = contentKind === 'issue' ? 'issues' : contentKind === 'review' ? 'pull_request_review'
      : contentKind === 'review_comment' ? 'pull_request_review_comment' : isComment || contentKind === 'issue_comment' ? 'issue_comment' : 'pull_request';
    const contentPayload = contentKind === 'issue' ? {
      issue: { number: 42, title: 'stale webhook text', body: 'stale webhook text' },
    } : contentKind === 'issue_comment' ? {
      issue: { number: 42 }, comment: { id: sourceId, body: 'stale webhook text', user: { type: 'Bot' } },
    } : contentKind ? {
      pull_request: { number: 42 },
      [contentKind === 'review' ? 'review' : 'comment']: { id: sourceId, body: 'stale webhook text' },
    } : null;
    const body = JSON.stringify({
      action: 'edited', installation: { id: 123 },
      repository: { name: 'demo', full_name: 'example-owner/demo', private: false,
        owner: { login: 'example-owner' } },
      ...(contentPayload || (isComment ? {
        issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/example-owner/demo/pulls/42' } },
        comment: { id: 55, body: 'stale webhook text', user: { type: 'Bot' } },
      } : { pull_request: { number: 42, title: 'stale webhook text', body: 'stale webhook text' } })),
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await mf.dispatchFetch('https://runtime.invalid/webhook', {
      method: 'POST', body,
      headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': `sha256=${signature}` },
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'accepted');
    await Promise.race([commentPosted, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native queue consumer did not post a comment within 10 seconds')), 10000);
    })]);
    if (contentKind) {
      const markerKind = contentKind.replace('_', '-');
      const marker = contentKind === 'issue' ? '<!-- pr-translator-bot:issue:v1 -->'
        : `<!-- pr-translator-bot:${markerKind}:v1:${sourceId} -->`;
      assert.ok(postedComment.startsWith(marker));
      assert.match(postedComment, bodyOnly ? /审查汇总/ : /Fix pagination/);
      if (bodyOnly) {
        const anchor = contentKind === 'review' ? `pullrequestreview-${sourceId}`
          : contentKind === 'review_comment' ? `discussion_r${sourceId}` : `issuecomment-${sourceId}`;
        assert.ok(postedComment.includes(`https://github.com/example-owner/demo/${issueContainer ? 'issues' : 'pull'}/42#${anchor}`));
      }
      assert.doesNotMatch(postedComment, /unexpected\.invalid|stale webhook text/);
    } else if (isComment) {
      assert.match(postedComment, /^<!-- pr-translator-bot:comment:v1:55 -->/);
      assert.match(postedComment, /https:\/\/github\.com\/example-owner\/demo\/pull\/42#issuecomment-55/);
      assert.match(postedComment, /审查汇总/);
      assert.doesNotMatch(postedComment, /unexpected\.invalid/);
    } else {
      assert.match(postedComment, /^<!-- pr-translator-bot:v1 -->/);
      assert.match(postedComment, /\*\*Fix pagination\*\*/);
      assert.match(postedComment, /Keep Markdown intact\./);
    }
    if (contentKind) {
      const repositoryPath = 'GET api.github.com/repos/example-owner/demo';
      const containerPath = `${repositoryPath}/${issueContainer ? 'issues' : 'pulls'}/42`;
      const sourcePath = contentKind === 'issue' ? containerPath : contentKind === 'issue_comment'
        ? `${repositoryPath}/issues/comments/${sourceId}` : contentKind === 'review'
          ? `${repositoryPath}/pulls/42/reviews/${sourceId}` : `${repositoryPath}/pulls/comments/${sourceId}`;
      assert.deepEqual(calls, [
        'POST api.github.com/app/installations/123/access_tokens', repositoryPath, containerPath,
        ...(contentKind === 'issue' ? [] : [sourcePath]),
        'POST generativelanguage.googleapis.com/v1beta/models/runtime-model:generateContent',
        sourcePath, ...(contentKind === 'issue' ? [] : [containerPath]), repositoryPath,
        'GET api.github.com/repos/example-owner/demo/issues/42/comments',
        'POST api.github.com/repos/example-owner/demo/issues/42/comments',
      ]);
    } else assert.deepEqual(calls, [
      'POST api.github.com/app/installations/123/access_tokens',
      'GET api.github.com/repos/example-owner/demo/pulls/42',
      ...(isComment ? ['GET api.github.com/repos/example-owner/demo/issues/comments/55'] : []),
      'POST generativelanguage.googleapis.com/v1beta/models/runtime-model:generateContent',
      ...(isComment ? [
        'GET api.github.com/repos/example-owner/demo/issues/comments/55',
        'GET api.github.com/repos/example-owner/demo/pulls/42',
      ] : []),
      'GET api.github.com/repos/example-owner/demo/issues/42/comments',
      'POST api.github.com/repos/example-owner/demo/issues/42/comments',
    ]);
  } finally {
    clearTimeout(timer);
    await mf.dispose();
  }
}

test('workerd queues a signed webhook and its native consumer posts the translation', { timeout: 20000 }, () => nativeQueueScenario());
test('workerd translates another bot discussion comment through its native queue consumer', { timeout: 20000 }, () => nativeQueueScenario(true));
for (const kind of ['issue', 'issue_comment', 'review', 'review_comment']) {
  test(`workerd handles ${kind} through its native queue consumer`, { timeout: 20000 }, () => nativeQueueScenario(false, kind));
}
