const encoder = new TextEncoder();
const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 10000;
const PR_MARKER = '<!-- pr-translator-bot:v1 -->';

export class GitHubFailure extends Error {
  constructor(message, retryable, status) {
    super(message);
    this.name = 'GitHubFailure';
    this.retryable = retryable;
    this.status = status;
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJwtPart(object) {
  return base64url(encoder.encode(JSON.stringify(object)));
}

export async function createAppJwt(env) {
  // Wrangler secret must be PKCS#8 PEM: -----BEGIN PRIVATE KEY-----.
  // Convert the downloaded GitHub key with `openssl pkcs8 -topk8 ...`.
  const pem = (env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('GITHUB_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY)');
  }
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {
    name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
  }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const tokenBody = `${encodeJwtPart({ alg: 'RS256', typ: 'JWT' })}.${encodeJwtPart({
    iat: now - 60,
    exp: now + 540,
    iss: String(env.GITHUB_APP_ID),
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(tokenBody)));
  return `${tokenBody}.${base64url(signature)}`;
}

async function checkedJson(response, service) {
  if (!response.ok) {
    // Response bodies may contain data that should not be written to logs.
    try { await response.body?.cancel(); } catch { /* Preserve the HTTP status. */ }
    throw new GitHubFailure(`${service} HTTP ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status);
  }
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    throw new GitHubFailure(`${service}: invalid or unreadable response`, true);
  }
}

async function githubRequest(url, options, service) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GitHubFailure(`${service}: timeout after ${GITHUB_TIMEOUT_MS} ms`, true));
    }, GITHUB_TIMEOUT_MS);
  });
  try {
    const request = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
      return checkedJson(response, service);
    })();
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof GitHubFailure) throw error;
    throw new GitHubFailure(`${service}: ${controller.signal.aborted ? 'timeout' : 'network error'}`, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function getInstallationToken(env, installationId, { requirePullRequestsWrite = false } = {}) {
  const jwt = await createAppJwt(env);
  const result = await githubRequest(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'pr-translator-bot',
    },
  }, 'GitHub installation token');
  if (!result || typeof result.token !== 'string' || !result.token) {
    throw new GitHubFailure('GitHub installation token: missing token', true);
  }
  if (requirePullRequestsWrite && (!result.permissions || typeof result.permissions !== 'object' || Array.isArray(result.permissions))) {
    throw new GitHubFailure('GitHub installation token: missing permissions for review replies', true);
  }
  if (result.permissions && typeof result.permissions === 'object' && !Array.isArray(result.permissions)) {
    const issues = ['read', 'write'].includes(result.permissions.issues) ? result.permissions.issues : 'none';
    const pullRequests = ['read', 'write'].includes(result.permissions.pull_requests)
      ? result.permissions.pull_requests : 'none';
    console.info(`GitHub installation permissions: issues=${issues}, pull_requests=${pullRequests}`);
    if (requirePullRequestsWrite && pullRequests !== 'write') {
      throw new GitHubFailure('GitHub App installation requires Pull requests write permission to publish translation Reviews and review comments; approve updated installation permissions', false);
    }
    if (issues !== 'write' && pullRequests !== 'write') {
      throw new GitHubFailure('GitHub App installation requires Issues or Pull requests write permission; approve updated installation permissions', false);
    }
  }
  return result.token;
}

export async function github(token, path, method = 'GET', data) {
  return githubRequest(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'pr-translator-bot',
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, `GitHub ${method} ${path}`);
}

export async function findBotComment(token, owner, repo, number, marker = PR_MARKER) {
  // Scan the first 500 discussion comments for this source's translation.
  for (let page = 1; page <= 5; page++) {
    const comments = await github(token,
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const matching = comments.find(c => c.user?.type === 'Bot' && c.body?.startsWith(marker));
    if (matching) return matching;
    if (comments.length < 100) break;
  }
  return null;
}

export async function findBotReviewComment(token, owner, repo, number, marker, rootId) {
  for (let page = 1; page <= 5; page++) {
    const comments = await github(token,
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100&page=${page}`);
    const matching = comments.find(c => c.user?.type === 'Bot'
      && c.body?.startsWith(marker) && c.in_reply_to_id === rootId);
    if (matching) return matching;
    if (comments.length < 100) return null;
  }
  // Do not create a duplicate when the existing translation may be beyond the limit.
  throw new GitHubFailure('Review translation lookup exceeds 500 comments', false);
}
