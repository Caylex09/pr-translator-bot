import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';

const expected = { sourceLanguage: 'en', title: '测试标题', body: '测试描述' };
const dummyKey = 'runtime-test-key-no-secret';
const worker = `import { translate } from './translation.js';
export default {
  async fetch(request) {
    const providers = await request.json();
    try {
      const translation = await translate({
        TRANSLATION_PROVIDERS: JSON.stringify(providers),
        TEST_API_KEY: '${dummyKey}',
      }, 'Test title', 'Test description');
      return Response.json(translation);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }
};`;

function provider(type, name = type, prefix = type) {
  return {
    name, type, model: 'test-model', api_key_env: 'TEST_API_KEY',
    base_url: `https://provider.invalid/${prefix}`,
  };
}

function apiResponse(type) {
  const text = JSON.stringify(expected);
  switch (type) {
    case 'gemini':
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
    case 'openai':
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
    case 'openai_responses':
      return Response.json({ status: 'completed', output: [{
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
      }] });
    case 'anthropic':
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
    default:
      throw new Error(`Unexpected mock provider type: ${type}`);
  }
}

async function withRuntime(handler, run) {
  const translationModule = await readFile(new URL('../src/translation.js', import.meta.url), 'utf8');
  const mf = new Miniflare({
    host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
    workers: [{
      config: {
        name: 'translation-runtime-test', compatibilityDate: '2026-10-13',
        manifest: { mainModule: 'worker.js', modules: {
          'worker.js': { type: 'esm', contents: worker },
          'translation.js': { type: 'esm', contents: translationModule },
        } },
      },
      dev: { outboundService: { type: 'fetcher', handler } },
    }],
  });
  try {
    await run(async providers => {
      const response = await mf.dispatchFetch('http://runtime.invalid/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(providers),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    });
  } finally {
    await mf.dispose();
  }
}

test('workerd sends valid requests and parses translations for all four adapters', async () => {
  const calls = [];
  await withRuntime(async request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'provider.invalid');
    assert.equal(request.method, 'POST');
    const type = url.pathname.split('/')[1];
    calls.push(type);
    const body = await request.json();
    if (type === 'gemini') {
      assert.equal(request.headers.get('x-goog-api-key'), dummyKey);
      assert.ok(body.contents.length);
    } else if (type === 'anthropic') {
      assert.equal(request.headers.get('x-api-key'), dummyKey);
      assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
      assert.equal(body.model, 'test-model');
    } else {
      assert.equal(request.headers.get('authorization'), `Bearer ${dummyKey}`);
      assert.equal(body.model, 'test-model');
    }
    return apiResponse(type);
  }, async translate => {
    for (const type of ['gemini', 'openai', 'openai_responses', 'anthropic']) {
      assert.deepEqual(await translate([provider(type)]), expected);
    }
  });
  assert.deepEqual(calls, ['gemini', 'openai', 'openai_responses', 'anthropic']);
});

test('workerd rejects redirects without forwarding credentials and uses the next provider', async () => {
  const calls = [];
  await withRuntime(request => {
    const url = new URL(request.url);
    calls.push(`${url.hostname}${url.pathname}`);
    assert.equal(url.hostname, 'provider.invalid', 'Redirect target must never receive a request');
    if (url.pathname.startsWith('/primary/')) {
      assert.equal(request.headers.get('x-goog-api-key'), dummyKey);
      return new Response(null, { status: 302, headers: { Location: 'https://unexpected.invalid/leak' } });
    }
    assert.equal(request.headers.get('authorization'), `Bearer ${dummyKey}`);
    return apiResponse('openai');
  }, async translate => {
    assert.deepEqual(await translate([
      provider('gemini', 'primary', 'primary'), provider('openai', 'backup', 'backup'),
    ]), expected);
  });
  assert.deepEqual(calls, [
    'provider.invalid/primary/models/test-model:generateContent',
    'provider.invalid/backup/chat/completions',
  ]);
});

test('workerd switches to the next provider after an HTTP 429 response', async () => {
  const calls = [];
  await withRuntime(request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'provider.invalid');
    calls.push(url.pathname);
    if (url.pathname.startsWith('/primary/')) return Response.json({ error: 'quota exhausted' }, { status: 429 });
    return apiResponse('openai_responses');
  }, async translate => {
    assert.deepEqual(await translate([
      provider('gemini', 'primary', 'primary'), provider('openai_responses', 'backup', 'backup'),
    ]), expected);
  });
  assert.deepEqual(calls, ['/primary/models/test-model:generateContent', '/backup/responses']);
});
