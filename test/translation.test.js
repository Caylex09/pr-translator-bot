import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, translateItems, TranslationFailure } from '../src/translation.js';

const translation = { sourceLanguage: 'zh', title: 'Fix pagination', body: 'Keep `page` and #42.' };
const asJson = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const geminiAnswer = (answer = translation) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }],
});
const chatAnswer = (answer = translation) => ({ choices: [{ message: { content: JSON.stringify(answer) } }] });
const providers = (...items) => ({
  TRANSLATION_PROVIDERS: JSON.stringify(items),
  PRIMARY_KEY: 'primary-secret-key', SECONDARY_KEY: 'secondary-secret-key',
});
const primary = { name: 'primary', type: 'gemini', model: 'gemini-test', api_key_env: 'PRIMARY_KEY' };
const secondary = {
  name: 'secondary', type: 'openai', model: 'translation-model', api_key_env: 'SECONDARY_KEY',
  base_url: 'https://backup.example/api/v1',
};

test('legacy Gemini configuration remains usable, including an empty provider setting', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return asJson(geminiAnswer());
  });
  for (const setting of [undefined, '']) {
    const env = { GEMINI_API_KEY: 'legacy-secret', GEMINI_MODEL: 'legacy-model' };
    if (setting !== undefined) env.TRANSLATION_PROVIDERS = setting;
    assert.deepEqual(await translate(env, '修复分页', '保留 `page` 和 #42。'), translation);
  }
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/legacy-model:generateContent');
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'legacy-secret');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!url.includes('legacy-secret'));
  }
});

test('legacy single Gemini can finish after the old eight-second limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => 10000);
  let finishRequest;
  let signal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    signal = init.signal;
    return new Promise(resolve => { finishRequest = resolve; });
  });
  const result = translate({ GEMINI_API_KEY: 'legacy-secret' }, '修复', '内容');
  t.mock.timers.tick(10000);
  assert.equal(signal.aborted, false);
  finishRequest(asJson(geminiAnswer()));
  assert.deepEqual(await result, translation);
});

test('legacy single Gemini times out at the configured shared budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => 10000);
  let signal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const result = translate({ GEMINI_API_KEY: 'legacy-secret', TRANSLATION_TIMEOUT_MS: '12000' }, '修复', '内容');
  const rejected = assert.rejects(result, /timeout after 12000 ms waiting for response headers/);
  t.mock.timers.tick(11999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('an explicit provider list keeps its default eight-second attempt limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => 10000);
  let signal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const result = translate(providers(primary), '修复', '内容');
  const rejected = assert.rejects(result, /timeout after 8000 ms/);
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('a durable queue translation can finish after the HTTP background window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => 10000);
  let finishRequest;
  let signal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    signal = init.signal;
    return new Promise(resolve => { finishRequest = resolve; });
  });
  const result = translate({ GEMINI_API_KEY: 'legacy-secret' }, '修复', '内容', { executionMode: 'queue' });
  t.mock.timers.tick(45000);
  assert.equal(signal.aborted, false);
  finishRequest(asJson(geminiAnswer()));
  assert.deepEqual(await result, translation);
});

test('a durable queue attempt aborts at its sixty-second default and is retryable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => 10000);
  let signal;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const result = translate({ GEMINI_API_KEY: 'legacy-secret' }, '修复', '内容', { executionMode: 'queue' });
  const rejected = assert.rejects(result, error => error instanceof TranslationFailure && error.retryable && /60000 ms/.test(error.message));
  t.mock.timers.tick(59999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('long provider timeouts require a queue consumer execution context', async t => {
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer()));
  const env = { ...providers({ ...primary, timeout_ms: 60000 }), TRANSLATION_TIMEOUT_MS: '90000' };
  await assert.rejects(translate(env, '修复', '内容'), /25000/);
  assert.deepEqual(await translate(env, '修复', '内容', { executionMode: 'queue' }), translation);
  await assert.rejects(translate({ ...env, TRANSLATION_TIMEOUT_MS: '120001' }, '修复', '内容', { executionMode: 'queue' }), /120000/);
});

test('only transient provider failures are eligible for delayed queue retries', async t => {
  for (const status of [400, 401, 402, 403, 404, 408, 429, 500, 503, 504]) {
    await t.test(`HTTP ${status}`, async subtest => {
      subtest.mock.method(globalThis, 'fetch', async () => asJson({ error: { message: 'not logged' } }, status));
      await assert.rejects(translate(providers(primary), '修复', '内容', { executionMode: 'queue' }), error =>
        error instanceof TranslationFailure && error.retryable === ([408, 429].includes(status) || status >= 500));
    });
  }
  await t.test('network failure', async subtest => {
    subtest.mock.method(globalThis, 'fetch', async () => { throw new Error('private network diagnostics'); });
    await assert.rejects(translate(providers(primary), '修复', '内容', { executionMode: 'queue' }), error =>
      error instanceof TranslationFailure && error.retryable && !error.message.includes('private network diagnostics'));
  });
  await t.test('network failure while reading the response body', async subtest => {
    subtest.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('private response stream diagnostics')); },
    })));
    await assert.rejects(translate(providers(primary), '修复', '内容', { executionMode: 'queue' }), error =>
      error instanceof TranslationFailure && error.retryable && !error.message.includes('private response stream diagnostics'));
  });
  await t.test('malformed response JSON is permanent', async subtest => {
    subtest.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
    await assert.rejects(translate(providers(primary), '修复', '内容', { executionMode: 'queue' }), error =>
      error instanceof TranslationFailure && !error.retryable);
  });
  await t.test('missing secret', async () => {
    await assert.rejects(translate({ TRANSLATION_PROVIDERS: JSON.stringify([primary]) }, '修复', '内容', { executionMode: 'queue' }), error =>
      error instanceof TranslationFailure && !error.retryable);
  });
});

test('the first successful provider stops the fallback chain', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return asJson(geminiAnswer());
  });
  assert.deepEqual(await translate(providers(primary, secondary), '修复分页', '内容'), translation);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-test:generateContent$/);
});

test('quota, payment, and server failures fall back in configuration order', async t => {
  for (const status of [429, 402, 500, 503]) {
    await t.test(`HTTP ${status}`, async subtest => {
      const calls = [];
      subtest.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url: String(url), init });
        return calls.length === 1
          ? asJson({ error: { message: 'provider quota exhausted' } }, status)
          : asJson(chatAnswer());
      });
      assert.deepEqual(await translate(providers(primary, secondary), '修复分页', '内容'), translation);
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
      assert.equal(calls[1].url, 'https://backup.example/api/v1/chat/completions');
      const headers = new Headers(calls[1].init.headers);
      assert.equal(headers.get('authorization'), 'Bearer secondary-secret-key');
      assert.equal(headers.get('x-goog-api-key'), null);
      assert.equal(calls[1].init.redirect, 'manual');
      assert.equal(JSON.parse(calls[1].init.body).model, 'translation-model');
    });
  }
});

test('multiple OpenAI-compatible sites can use distinct models and keys', async t => {
  const calls = [];
  const first = { ...secondary, name: 'site-one', model: 'model-one', api_key_env: 'PRIMARY_KEY', base_url: 'https://one.example/v1/' };
  const second = { ...secondary, name: 'site-two', model: 'model-two', base_url: 'https://two.example/custom/v1' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? asJson({}, 429) : asJson(chatAnswer());
  });
  assert.deepEqual(await translate(providers(first, second), '修复', '内容'), translation);
  assert.deepEqual(calls.map(call => call.url), [
    'https://one.example/v1/chat/completions', 'https://two.example/custom/v1/chat/completions',
  ]);
  assert.deepEqual(calls.map(call => JSON.parse(call.init.body).model), ['model-one', 'model-two']);
  assert.deepEqual(calls.map(call => new Headers(call.init.headers).get('authorization')),
    ['Bearer primary-secret-key', 'Bearer secondary-secret-key']);
});

test('HTTP redirects are rejected without forwarding credentials to the Location URL', async t => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(`HTTP ${status}`, async subtest => {
      const calls = [];
      subtest.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url: String(url), init });
        assert.equal(init.redirect, 'manual');
        return calls.length === 1
          ? new Response(null, { status, headers: { Location: 'https://untrusted.example/collect-key' } })
          : asJson(chatAnswer());
      });
      assert.deepEqual(await translate(providers(primary, secondary), '修复', '内容'), translation);
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => !call.url.startsWith('https://untrusted.example/')));
      assert.equal(calls[1].url, 'https://backup.example/api/v1/chat/completions');
    });
  }
});

test('provider defaults target the official API endpoints', async t => {
  const cases = [
    ['openai', 'https://api.openai.com/v1/chat/completions', chatAnswer()],
    ['openai_responses', 'https://api.openai.com/v1/responses', { output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(translation) }] },
    ] }],
    ['anthropic', 'https://api.anthropic.com/v1/messages', { content: [{ type: 'text', text: JSON.stringify(translation) }] }],
  ];
  for (const [type, endpoint, answer] of cases) {
    await t.test(type, async subtest => {
      let requestedUrl;
      subtest.mock.method(globalThis, 'fetch', async (url, init) => {
        requestedUrl = String(url);
        assert.equal(init.redirect, 'manual');
        if (type === 'anthropic') assert.equal(JSON.parse(init.body).max_tokens, 8192);
        return asJson(answer);
      });
      assert.deepEqual(await translate(providers({ name: type, type, model: 'test-model', api_key_env: 'PRIMARY_KEY' }), '修复', '内容'), translation);
      assert.equal(requestedUrl, endpoint);
    });
  }
});

test('missing credentials skip a provider without issuing its request', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return asJson(chatAnswer());
  });
  const env = providers(primary, secondary);
  delete env.PRIMARY_KEY;
  assert.deepEqual(await translate(env, '修复', '内容'), translation);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /backup\.example/);
});

test('network errors, invalid response JSON, and invalid translation schemas fall back', async t => {
  const failures = [
    ['network error', () => { throw new TypeError('network failed'); }],
    ['non-JSON response', () => new Response('not JSON')],
    ['non-JSON model output', () => asJson({ candidates: [{ content: { parts: [{ text: 'not JSON' }] } }] })],
    ['unsupported source language', () => asJson(geminiAnswer({ ...translation, sourceLanguage: 'fr' }))],
    ['non-string title', () => asJson(geminiAnswer({ ...translation, title: 42 }))],
    ['missing body', () => asJson(geminiAnswer({ sourceLanguage: 'zh', title: 'Fix' }))],
    ['null translation', () => asJson(geminiAnswer(null))],
  ];
  for (const [name, firstResponse] of failures) {
    await t.test(name, async subtest => {
      let attempts = 0;
      subtest.mock.method(globalThis, 'fetch', async () => ++attempts === 1 ? firstResponse() : asJson(chatAnswer()));
      assert.deepEqual(await translate(providers(primary, secondary), '修复', '内容'), translation);
      assert.equal(attempts, 2);
    });
  }
});

const reviewBody = `## Review
This change returns the cached token before checking whether the application installation has permission to write comments.

<details><summary>Additional context</summary>

Please validate the installation permissions before the existing token is used. Keep \`issues:write\` and [the API documentation](https://docs.example.test/api) available for the caller.

\`\`\`js
return cachedToken;
\`\`\`
</details>`;
const translatedReview = {
  sourceLanguage: 'en', title: '',
  body: `## 审查
这项修改在检查应用安装是否拥有写入评论的权限之前，返回了缓存的令牌。

<details><summary>补充说明</summary>

请先验证安装权限，再使用已有令牌。保留 \`issues:write\`，并让调用者可以查阅 [API 文档](https://docs.example.test/api)。

\`\`\`js
return cachedToken;
\`\`\`
</details>`,
};

test('a copied Codex-style English review falls back rather than being posted as a translation', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    return calls.length === 1
      ? asJson(geminiAnswer({ sourceLanguage: 'en', title: '', body: reviewBody }))
      : asJson(chatAnswer(translatedReview));
  });
  assert.deepEqual(await translate(providers(primary, secondary), '', reviewBody), translatedReview);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /backup\.example/);
});

test('a false language declaration cannot bypass the copied English prose check', async t => {
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer({ sourceLanguage: 'zh', title: '', body: reviewBody })));
  await assert.rejects(translate(providers(primary), '', reviewBody), error =>
    error instanceof TranslationFailure && error.retryable && /incorrect source language/.test(error.message));
});

test('an incorrect source language in a batch causes provider fallback', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer({ items: [
    { id: 'review', sourceLanguage: ++attempts === 1 ? 'zh' : 'en', title: '',
      body: attempts === 1 ? reviewBody : translatedReview.body },
  ] })));
  const result = await translateItems(providers(primary, { ...primary, name: 'backup' }), [
    { id: 'review', title: '', body: reviewBody },
  ]);
  assert.equal(attempts, 2);
  assert.equal(result[0].sourceLanguage, 'en');
  assert.equal(result[0].body, translatedReview.body);
});

test('English paraphrases without Chinese are also retryable non-translations', async t => {
  const answer = { sourceLanguage: 'en', title: '', body: 'The cached token is returned before the installation permissions are checked, so this needs to be changed.' };
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
  await assert.rejects(translate(providers(primary), '', reviewBody, { executionMode: 'queue' }), error =>
    error instanceof TranslationFailure && error.retryable && /contains no Chinese prose/.test(error.message));
});

test('all providers copying prose leave a retryable failure without exposing the source', async t => {
  const privateBody = `${reviewBody}\nThis additional sentence contains private-review-details.`;
  let attempts = 0;
  const answer = { sourceLanguage: 'en', title: '', body: privateBody };
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? asJson(geminiAnswer(answer)) : asJson(chatAnswer(answer)));
  await assert.rejects(translate(providers(primary, secondary), '', privateBody, { executionMode: 'queue' }), error => {
    assert.ok(error instanceof TranslationFailure);
    assert.equal(error.retryable, true);
    assert.match(error.message, /copied source prose unchanged/);
    assert.ok(!error.message.includes('private-review-details'));
    return true;
  });
  assert.equal(attempts, 2);
});

test('substantial Chinese prose copied unchanged is rejected as well', async t => {
  const body = '这项修改在检查应用安装是否拥有写入评论的权限之前，返回了缓存的令牌。请先验证安装权限，再使用已有令牌。';
  const answer = { sourceLanguage: 'zh', title: '', body };
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
  await assert.rejects(translate(providers(primary), '', body), error =>
    error instanceof TranslationFailure && error.retryable && /copied source prose unchanged/.test(error.message));
});

test('code, links, identifiers, and short labels may remain unchanged', async t => {
  const body = `\`\`\`text
The installation has permission to write comments before the cached token is used.
\`\`\`

~~~text
The installation has permission to write comments before the cached token is used.
~~~

\`The installation has permission to write comments before the cached token is used.\`
https://example.test/the-installation-has-permission-to-write-comments
@reviewer #42 src/github.js getInstallationToken API HTTP NODE_OPTIONS
<span data-note="The installation has permission to write comments before the cached token is used.">OK</span>
<!-- The installation has permission to write comments before the cached token is used. -->`;
  const answer = { sourceLanguage: 'en', title: 'API', body };
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
  assert.deepEqual(await translate(providers(primary), 'API', body), answer);
});

test('indented, quoted, and unclosed fenced code do not need to translate', async t => {
  const sentence = 'The installation has permission to write comments before the cached token is used.';
  for (const body of [`    ${sentence}`, `> \`\`\`text\n> ${sentence}\n> \`\`\`\``, `~~~text\n${sentence}`]) {
    const answer = { sourceLanguage: 'en', title: '', body };
    t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
    assert.deepEqual(await translate(providers(primary), '', body), answer);
    t.mock.restoreAll();
  }
});

test('already target-language portions do not need to change', async t => {
  const cases = [
    {
      title: 'Review', body: '这项修改在检查应用安装是否拥有写入评论的权限之前，返回了缓存的令牌。请先验证安装权限，再使用已有令牌。',
      answer: { sourceLanguage: 'en', title: '审查', body: '这项修改在检查应用安装是否拥有写入评论的权限之前，返回了缓存的令牌。请先验证安装权限，再使用已有令牌。' },
    },
    {
      title: '审查', body: 'Please validate the installation permissions before the existing token is used by the application to write comments.',
      answer: { sourceLanguage: 'zh', title: 'Review', body: 'Please validate the installation permissions before the existing token is used by the application to write comments.' },
    },
  ];
  for (const { title, body, answer } of cases) {
    t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
    assert.deepEqual(await translate(providers(primary), title, body), answer);
    t.mock.restoreAll();
  }
});

test('Chinese inside preserved code does not pass as translated English prose', async t => {
  const answer = { sourceLanguage: 'en', title: '', body: 'The cached token is returned before the installation permissions are checked.\n```js\nconst label = "中文";\n```' };
  t.mock.method(globalThis, 'fetch', async () => asJson(geminiAnswer(answer)));
  await assert.rejects(translate(providers(primary), '', reviewBody), error =>
    error instanceof TranslationFailure && error.retryable && /contains no Chinese prose/.test(error.message));
});

test('a JSON code fence around model output is accepted', async t => {
  t.mock.method(globalThis, 'fetch', async () => asJson({
    choices: [{ message: { content: `\n\x60\x60\x60json\n${JSON.stringify(translation)}\n\x60\x60\x60\n` } }],
  }));
  assert.deepEqual(await translate(providers(secondary), '修复', '内容'), translation);
});

test('Anthropic messages use the configured endpoint, model, headers, and text blocks', async t => {
  const calls = [];
  const provider = {
    name: 'anthropic', type: 'anthropic', model: 'claude-test', api_key_env: 'PRIMARY_KEY',
    base_url: 'https://anthropic.example/v1/', max_tokens: 1234,
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = JSON.stringify(translation);
    return asJson({ content: [
      { type: 'thinking', thinking: 'Do not parse this block' },
      { type: 'text', text: answer.slice(0, 30) }, { type: 'text', text: answer.slice(30) },
    ] });
  });
  assert.deepEqual(await translate(providers(provider), '修复', '内容'), translation);
  assert.equal(calls[0].url, 'https://anthropic.example/v1/messages');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('x-api-key'), 'primary-secret-key');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('authorization'), null);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-test');
  assert.equal(body.max_tokens, 1234);
  assert.ok(Array.isArray(body.messages));
});

test('OpenAI Responses parses only assistant message output_text blocks', async t => {
  const calls = [];
  const provider = { ...secondary, type: 'openai_responses', model: 'responses-test', json_mode: true };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = JSON.stringify(translation);
    return asJson({ output: [
      { type: 'function_call', arguments: 'ignore tool output', content: [{ type: 'output_text', text: 'invalid JSON' }] },
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'ignore user message' }] },
      { type: 'message', role: 'assistant', content: [
        { type: 'refusal', refusal: 'ignore non-text block' },
        { type: 'output_text', text: answer.slice(0, 20) },
        { type: 'output_text', text: answer.slice(20) },
      ] },
    ] });
  });
  assert.deepEqual(await translate(providers(provider), '修复', '内容'), translation);
  assert.equal(calls[0].url, 'https://backup.example/api/v1/responses');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'responses-test');
  assert.equal(body.text?.format?.type, 'json_object');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer secondary-secret-key');
});

test('OpenAI JSON mode is opt-in so compatible sites can return plain text', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(JSON.parse(init.body));
    return asJson(chatAnswer());
  });
  await translate(providers(secondary), '修复', '内容');
  await translate(providers({ ...secondary, json_mode: true }), '修复', '内容');
  assert.equal(requests[0].response_format, undefined);
  assert.deepEqual(requests[1].response_format, { type: 'json_object' });
});

test('request timeout aborts the provider and permits fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 2) return Promise.resolve(asJson(chatAnswer()));
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const result = translate(providers({ ...primary, timeout_ms: 100 }, secondary), '修复', '内容');
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.deepEqual(await result, translation);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('timeout remains active while reading a response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  let firstSignal;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    attempts += 1;
    if (attempts > 1) return asJson(chatAnswer());
    firstSignal = init.signal;
    return {
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    };
  });
  const result = translate(providers({ ...primary, timeout_ms: 100 }, secondary), '修复', '内容');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(firstSignal.aborted, false);
  t.mock.timers.tick(100);
  assert.deepEqual(await result, translation);
  assert.equal(attempts, 2);
  assert.equal(firstSignal.aborted, true);
});

test('the shared deadline prevents starting another request after the budget is exhausted', async t => {
  let now = 10000;
  let attempts = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    now += 1001;
    return asJson({}, 429);
  });
  const env = { ...providers(primary, secondary), TRANSLATION_TIMEOUT_MS: '1000' };
  await assert.rejects(translate(env, '修复', '内容'), /timeout|deadline|budget/i);
  assert.equal(attempts, 1);
});

test('all-provider errors do not expose keys, response bodies, or raw network errors', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    if (attempts === 1) return new Response('private-response-body primary-secret-key', { status: 402 });
    throw new Error('raw-network-details secondary-secret-key');
  });
  await assert.rejects(translate(providers(primary, secondary), '修复', '内容'), error => {
    assert.match(error.message, /primary/);
    assert.match(error.message, /secondary/);
    assert.match(error.message, /402/);
    for (const sensitive of ['primary-secret-key', 'secondary-secret-key', 'private-response-body', 'raw-network-details']) {
      assert.ok(!error.message.includes(sensitive), `error contains ${sensitive}`);
    }
    return true;
  });
  assert.equal(attempts, 2);
});

test('invalid provider configuration fails before contacting any provider', async t => {
  const cases = [
    ['malformed JSON', '{'],
    ['object instead of array', '{}'],
    ['empty array', '[]'],
    ['duplicate names', JSON.stringify([primary, { ...secondary, name: primary.name }])],
    ['invalid name', JSON.stringify([{ ...primary, name: 'invalid/name' }])],
    ['invalid key environment variable', JSON.stringify([{ ...primary, api_key_env: 'primary-key' }])],
    ['unsupported type', JSON.stringify([{ ...primary, type: 'unknown' }])],
    ['missing model', JSON.stringify([{ ...primary, model: '' }])],
    ['HTTP endpoint', JSON.stringify([{ ...primary, base_url: 'http://unsafe.example/v1beta' }])],
    ['invalid endpoint', JSON.stringify([{ ...primary, base_url: 'not-a-url' }])],
    ['timeout below minimum', JSON.stringify([{ ...primary, timeout_ms: 99 }])],
    ['timeout above maximum', JSON.stringify([{ ...primary, timeout_ms: 25001 }])],
    ['fractional timeout', JSON.stringify([{ ...primary, timeout_ms: 100.5 }])],
    ['string timeout', JSON.stringify([{ ...primary, timeout_ms: '1000' }])],
    ['non-boolean JSON mode', JSON.stringify([{ ...secondary, json_mode: 'true' }])],
    ['JSON mode for unsupported API type', JSON.stringify([{ ...primary, json_mode: true }])],
    ['invalid Anthropic token limit', JSON.stringify([{ ...primary, type: 'anthropic', max_tokens: 0 }])],
    ['token limit for unsupported API type', JSON.stringify([{ ...secondary, max_tokens: 8192 }])],
    ['later invalid provider', JSON.stringify([primary, { ...secondary, base_url: 'http://unsafe.example/v1' }])],
  ];
  for (const [name, configuration] of cases) {
    await t.test(name, async subtest => {
      let calls = 0;
      subtest.mock.method(globalThis, 'fetch', async () => { calls += 1; return asJson(geminiAnswer()); });
      await assert.rejects(translate({ ...providers(), TRANSLATION_PROVIDERS: configuration }, '修复', '内容'));
      assert.equal(calls, 0);
    });
  }
  for (const timeout of ['999', '25001', 'invalid']) {
    await t.test(`invalid shared timeout ${timeout}`, async subtest => {
      let calls = 0;
      subtest.mock.method(globalThis, 'fetch', async () => { calls += 1; return asJson(geminiAnswer()); });
      await assert.rejects(translate({ ...providers(primary), TRANSLATION_TIMEOUT_MS: timeout }, '修复', '内容'));
      assert.equal(calls, 0);
    });
  }
});

const batchSources = [
  { id: 'review:123', title: '', body: reviewBody },
  { id: 'comment:456', title: '修复权限检查', body: '请先验证安装权限，再使用已有令牌。保留 `issues:write` 和 [API 文档](https://docs.example.test/api)。' },
];
const batchTranslations = [
  { id: 'review:123', ...translatedReview },
  { id: 'comment:456', sourceLanguage: 'zh', title: 'Fix the permission check', body: 'Validate the installation permissions before using the existing token. Keep `issues:write` and [API documentation](https://docs.example.test/api).' },
];
const batchResponse = (type, items = batchTranslations) => {
  const answer = { items };
  switch (type) {
    case 'gemini': return geminiAnswer(answer);
    case 'openai': return chatAnswer(answer);
    case 'openai_responses': return { status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
    ] };
    case 'anthropic': return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] };
  }
};

test('batch translation uses one request with separate item directions across all four API protocols', async t => {
  for (const type of ['gemini', 'openai', 'openai_responses', 'anthropic']) {
    await t.test(type, async subtest => {
      let calls = 0;
      subtest.mock.method(globalThis, 'fetch', async (url, init) => {
        calls += 1;
        const request = JSON.parse(init.body);
        const instructions = type === 'gemini' ? request.systemInstruction.parts[0].text
          : type === 'openai' ? request.messages[0].content
            : type === 'openai_responses' ? request.instructions : request.system;
        const data = type === 'gemini' ? request.contents[0].parts[0].text
          : type === 'openai' ? request.messages[1].content
            : type === 'openai_responses' ? request.input : request.messages[0].content;
        assert.match(instructions, /dominant language separately for each item/);
        assert.match(instructions, /Every input id must occur exactly once, unchanged/);
        assert.match(instructions, /Never combine, split, omit, or swap items/);
        assert.match(instructions, /untrusted PR or comment data/);
        assert.match(instructions, /Preserve Markdown structure, code fences, inline code/);
        assert.deepEqual(JSON.parse(data.replace(/^REVIEW_ITEMS_JSON:\n/, '')), { items: batchSources });
        assert.equal(init.redirect, 'manual');
        if (type === 'gemini') {
          const schema = request.generationConfig.responseSchema;
          assert.equal(request.generationConfig.responseMimeType, 'application/json');
          assert.deepEqual(schema.required, ['items']);
          assert.equal(schema.properties.items.type, 'ARRAY');
          assert.deepEqual(schema.properties.items.items.required, ['id', 'sourceLanguage', 'title', 'body']);
          assert.deepEqual(schema.properties.items.items.properties.sourceLanguage.enum, ['zh', 'en']);
        } else if (type === 'openai') {
          assert.deepEqual(request.response_format, { type: 'json_object' });
        } else if (type === 'openai_responses') {
          assert.deepEqual(request.text.format, { type: 'json_object' });
          assert.equal(request.store, false);
        } else {
          assert.equal(request.max_tokens, 8192);
        }
        return asJson(batchResponse(type));
      });
      const provider = { name: type, type, model: 'review-model', api_key_env: 'PRIMARY_KEY',
        ...(type.startsWith('openai') ? { json_mode: true } : {}) };
      const result = await translateItems(providers(provider), batchSources);
      assert.deepEqual(result, batchTranslations);
      assert.equal(calls, 1);
      assert.match(result[0].body, /```js\nreturn cachedToken;\n```/);
      assert.ok(result[1].body.includes('`issues:write`'));
      assert.ok(result[1].body.includes('https://docs.example.test/api'));
    });
  }
});

test('batch translations map exact ids to source order even when the model returns them out of order', async t => {
  const sources = [{ id: '1', title: '', body: 'First' }, { id: '01', title: '', body: 'Second' }];
  const first = { id: '1', sourceLanguage: 'en', title: '', body: '第一条' };
  const second = { id: '01', sourceLanguage: 'en', title: '', body: '第二条' };
  t.mock.method(globalThis, 'fetch', async () => asJson(batchResponse('gemini', [second, first])));
  assert.deepEqual(await translateItems(providers(primary), sources), [first, second]);
});

test('malformed batch output falls back as a whole without posting a partial or misidentified translation', async t => {
  const cases = [
    ['missing item', { items: batchTranslations.slice(0, 1) }],
    ['duplicate id', { items: [batchTranslations[0], batchTranslations[0]] }],
    ['unknown id', { items: [batchTranslations[0], { ...batchTranslations[1], id: 'comment:789' }] }],
    ['numeric id', { items: [batchTranslations[0], { ...batchTranslations[1], id: 456 }] }],
    ['different id case', { items: [batchTranslations[0], { ...batchTranslations[1], id: 'Comment:456' }] }],
    ['missing body', { items: [batchTranslations[0], { id: 'comment:456', sourceLanguage: 'zh', title: 'Title' }] }],
    ['wrong language', { items: [batchTranslations[0], { ...batchTranslations[1], sourceLanguage: 'fr' }] }],
    ['extra item field', { items: [batchTranslations[0], { ...batchTranslations[1], note: 'invented' }] }],
    ['extra envelope field', { items: batchTranslations, note: 'invented' }],
    ['invented body-only title', { items: [{ ...batchTranslations[0], title: 'Invented' }, batchTranslations[1]] }],
    ['array envelope', batchTranslations],
    ['null envelope', null],
  ];
  for (const [name, answer] of cases) {
    await t.test(name, async subtest => {
      let calls = 0;
      subtest.mock.method(globalThis, 'fetch', async () => ++calls === 1
        ? asJson(geminiAnswer(answer)) : asJson(batchResponse('openai')));
      assert.deepEqual(await translateItems(providers(primary, secondary), batchSources), batchTranslations);
      assert.equal(calls, 2);
    });
  }
  await t.test('malformed JSON', async subtest => {
    let calls = 0;
    subtest.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? asJson({ candidates: [{ content: { parts: [{ text: '{"items":[' }] } }] })
      : asJson(batchResponse('openai')));
    assert.deepEqual(await translateItems(providers(primary, secondary), batchSources), batchTranslations);
    assert.equal(calls, 2);
  });
});

test('an unchanged English batch item makes the complete batch fall back', async t => {
  let calls = 0;
  const copied = [{ ...batchTranslations[0], body: reviewBody }, batchTranslations[1]];
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? asJson(batchResponse('gemini', copied)) : asJson(batchResponse('openai')));
  assert.deepEqual(await translateItems(providers(primary, secondary), batchSources), batchTranslations);
  assert.equal(calls, 2);
});

test('batch content failure is retryable and exposes no item ids, source text, or credentials', async t => {
  const id = 'private-source-review-id';
  const body = 'The private source text needs to be translated before it is posted to the review.';
  const source = { id, title: '', body };
  const copied = { id, sourceLanguage: 'en', title: '', body };
  const logs = [];
  t.mock.method(console, 'info', line => logs.push(line));
  t.mock.method(console, 'warn', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => asJson(batchResponse('gemini', [copied])));
  await assert.rejects(translateItems(providers(primary), [source], { executionMode: 'queue' }), error => {
    assert.ok(error instanceof TranslationFailure);
    assert.equal(error.retryable, true);
    assert.match(error.message, /copied source prose unchanged/);
    logs.push(error.message);
    return true;
  });
  for (const line of logs) {
    for (const sensitive of [id, body, 'primary-secret-key']) assert.ok(!line.includes(sensitive));
  }
});

test('batch uses the shared provider deadline instead of a new budget for each item', async t => {
  let now = 10000;
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    now += 1001;
    return asJson({}, 429);
  });
  const env = { ...providers(primary, secondary), TRANSLATION_TIMEOUT_MS: '1000' };
  await assert.rejects(translateItems(env, batchSources), error =>
    error instanceof TranslationFailure && error.retryable && /shared time budget exhausted/.test(error.message));
  assert.equal(calls, 1);
});

test('invalid batch input fails before contacting providers and the 101-item boundary is accepted', async t => {
  const invalid = [null, {}, [], Array.from({ length: 102 }, (_, i) => ({ id: String(i), title: '', body: '' })),
    [batchSources[0], batchSources[0]], [{ id: 123, title: '', body: '' }],
    [{ id: '', title: '', body: '' }], [{ id: ' ', title: '', body: '' }],
    [{ id: 'valid', title: null, body: '' }], [{ id: 'valid', title: '', body: undefined }],
    [{ id: 'valid', title: '', body: '', injected: 'field' }]];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('unexpected request'); });
  for (const items of invalid) await assert.rejects(translateItems(providers(primary), items), /Translation batch/);
  assert.equal(calls, 0);
  const sources = Array.from({ length: 101 }, (_, i) => ({ id: String(i), title: '', body: 'Code' }));
  const expected = sources.map(item => ({ ...item, sourceLanguage: 'en', body: '代码' }));
  t.mock.method(globalThis, 'fetch', async () => asJson(batchResponse('gemini', expected)));
  assert.deepEqual(await translateItems(providers(primary), sources), expected);
});
