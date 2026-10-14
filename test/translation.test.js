import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, TranslationFailure } from '../src/translation.js';

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
