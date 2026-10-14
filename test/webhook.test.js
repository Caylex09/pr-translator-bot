import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { verifySignature, createAppJwt } from '../src/index.js';

test('webhook signature validation follows GitHub HMAC SHA256', async () => {
  const secret = "It's a Secret to Everybody";
  const body = 'Hello, World!';
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(sig, '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
  assert.equal(await verifySignature(body, `sha256=${sig}`, secret), true);
  assert.equal(await verifySignature(body + '!', `sha256=${sig}`, secret), false);
  assert.equal(await verifySignature(body, null, secret), false);
});

test('GitHub App JWT is signed with RS256', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwt = await createAppJwt({ GITHUB_PRIVATE_KEY: privateKey, GITHUB_APP_ID: '12345' });
  const [header, payload, signature] = jwt.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'RS256');
  assert.equal(json.iss, '12345');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});
