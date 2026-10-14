// GitHub App PR translator for Cloudflare Workers.
// Translates PRs, Issues, their comments, and PR review text.
import { translate } from './translation.js';
import { createAppJwt, getInstallationToken, github, GitHubFailure, findBotComment } from './github.js';
import { processContentJob } from './content.js';

const encoder = new TextEncoder();
const MARKER = '<!-- pr-translator-bot:v1 -->';
const COMMENT_MARKER_PREFIX = '<!-- pr-translator-bot:comment:v1:';
const GITHUB_API = 'https://api.github.com';
const MAX_DESCRIPTION_CHARS = 12000;
const RETRY_DELAYS_SECONDS = [30, 60, 120];
const EVENT_ACTIONS = {
  pull_request: ['opened', 'edited', 'reopened', 'ready_for_review'],
  issues: ['opened', 'edited', 'reopened'],
  issue_comment: ['created', 'edited'],
  pull_request_review: ['submitted', 'edited'],
  pull_request_review_comment: ['created', 'edited'],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('PR Translator Bot is running', { status: 200 });
    }
    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    // Verify the exact raw payload before parsing it.
    const body = await request.text();
    const signature = request.headers.get('X-Hub-Signature-256');
    const valid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!valid) return new Response('Invalid webhook signature', { status: 401 });

    const event = request.headers.get('X-GitHub-Event');
    if (event === 'ping') return new Response('pong', { status: 200 });
    if (!Object.hasOwn(EVENT_ACTIONS, event)) {
      return new Response('ignored', { status: 200 });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return new Response('Invalid JSON', { status: 400 });
    }
    const isComment = event === 'issue_comment';
    const isIssue = event === 'issues';
    const isReview = event === 'pull_request_review';
    const isReviewComment = event === 'pull_request_review_comment';
    if (!EVENT_ACTIONS[event].includes(payload.action)) {
      return new Response('ignored action', { status: 200 });
    }
    if (isIssue && payload.issue?.pull_request) {
      return new Response('ignored', { status: 200 });
    }
    const source = isReview ? payload.review : (isComment || isReviewComment) ? payload.comment : null;
    if (source && (isTranslationComment(source.body) || isOwnAppComment(source, env))) {
      return new Response('ignored translation comment', { status: 200 });
    }
    const number = isComment || isIssue ? payload.issue?.number : payload.pull_request?.number;
    if (!payload.installation?.id || !payload.repository?.full_name || !number
      || ((isComment || isReview || isReviewComment) && !source?.id)) {
      return new Response('Missing installation/PR', { status: 400 });
    }
    const targetOwner = typeof env.TARGET_OWNER === 'string' ? env.TARGET_OWNER.toLowerCase() : '';
    const repositoryOwner = payload.repository.owner?.login;
    if (!targetOwner || typeof repositoryOwner !== 'string' || repositoryOwner.toLowerCase() !== targetOwner) {
      return new Response('ignored owner', { status: 200 });
    }
    // Free translation API tiers may use input content for model improvement.
    if (payload.repository.private && env.ALLOW_PRIVATE !== 'true') {
      return new Response('ignored private repository', { status: 200 });
    }

    let job;
    try {
      let type;
      if (event === 'pull_request') type = { version: 1 };
      else if (isComment && payload.issue?.pull_request) type = { version: 2, kind: 'issue_comment', commentId: source.id };
      else if (isIssue) type = { version: 3, kind: 'issue' };
      else type = { version: 3, kind: isReview ? 'review' : isReviewComment ? 'review_comment' : 'issue_comment', sourceId: source.id };
      job = validateJob({
        ...type,
        installationId: payload.installation.id,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        number,
      });
    } catch {
      return new Response('Invalid installation/repository/PR', { status: 400 });
    }
    if (env.TRANSLATION_QUEUE) {
      try {
        // Persist identifiers only; the consumer fetches current source text itself.
        await env.TRANSLATION_QUEUE.send(job);
        console.info(`Translation queued: ${job.kind || 'pull_request'}`);
      } catch {
        console.error('PR translation queue write failed');
        return new Response('Unable to queue translation', { status: 503 });
      }
      return new Response('accepted', { status: 202 });
    }

    // Keep the original bounded background mode for deployments without Queues.
    ctx.waitUntil(processJob(job, env).catch(error => {
      console.error('PR translation failed:', error.message);
    }));
    return new Response('accepted', { status: 202 });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      let job;
      try {
        job = validateJob(message.body);
      } catch {
        // Never copy an untrusted or malformed message into the dead-letter queue.
        console.error('Invalid PR translation queue message; discarded');
        message.ack();
        continue;
      }
      const targetOwner = (env.TARGET_OWNER || '').toLowerCase();
      if (!targetOwner || job.owner.toLowerCase() !== targetOwner) {
        console.info('PR translation queue message skipped: owner');
        message.ack();
        continue;
      }
      try {
        await processJob(job, env, { executionMode: 'queue' });
        message.ack();
      } catch (error) {
        const attempt = Number.isSafeInteger(message.attempts) && message.attempts > 0
          ? message.attempts : 1;
        console.error('Queued PR translation failed:', error.message);
        if (error.retryable === true && attempt <= RETRY_DELAYS_SECONDS.length) {
          const delaySeconds = RETRY_DELAYS_SECONDS[attempt - 1];
          console.warn(`PR translation retry scheduled in ${delaySeconds} seconds`);
          message.retry({ delaySeconds });
          continue;
        }
        if (!env.TRANSLATION_DLQ) {
          // Wrangler's max_retries / dead_letter_queue remains the fallback.
          console.error('PR translation dead-letter binding unavailable');
          message.retry({ delaySeconds: 30 });
          continue;
        }
        try {
          await env.TRANSLATION_DLQ.send(job);
          console.error('PR translation saved to dead-letter queue');
          message.ack();
        } catch {
          console.error('PR translation dead-letter queue write failed');
          message.retry({ delaySeconds: 30 });
        }
      }
    }
  },
};

function validateJob(value) {
  const isComment = value?.version === 2 && value?.kind === 'issue_comment';
  const isContent = value?.version === 3 && ['issue', 'issue_comment', 'review', 'review_comment'].includes(value?.kind);
  const hasSource = isContent && value.kind !== 'issue';
  const fields = isContent ? ['version', 'kind', 'installationId', 'owner', 'repo', 'number', ...(hasSource ? ['sourceId'] : [])] : isComment
    ? ['version', 'kind', 'installationId', 'owner', 'repo', 'number', 'commentId']
    : ['version', 'installationId', 'owner', 'repo', 'number'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
    || (!isContent && !isComment && value.version !== 1)
    || (isComment && (!Number.isSafeInteger(value.commentId) || value.commentId <= 0))
    || (hasSource && (!Number.isSafeInteger(value.sourceId) || value.sourceId <= 0))
    || !Number.isSafeInteger(value.installationId) || value.installationId <= 0
    || !Number.isSafeInteger(value.number) || value.number <= 0
    || typeof value.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.owner)
    || typeof value.repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.repo)
    || value.repo === '.' || value.repo === '..') {
    throw new Error('Invalid PR translation job');
  }
  return { version: isContent ? 3 : isComment ? 2 : 1,
    ...(isContent ? { kind: value.kind, ...(hasSource ? { sourceId: value.sourceId } : {}) } : isComment ? { kind: 'issue_comment', commentId: value.commentId } : {}),
    installationId: value.installationId,
    owner: value.owner, repo: value.repo, number: value.number };
}

function isTranslationComment(body) {
  return typeof body === 'string'
    && body.trimStart().startsWith('<!-- pr-translator-bot:');
}

function isOwnAppComment(comment, env) {
  const appId = comment?.performed_via_github_app?.id;
  return appId !== undefined && appId !== null
    && env.GITHUB_APP_ID !== undefined && env.GITHUB_APP_ID !== null
    && String(appId) === String(env.GITHUB_APP_ID);
}

async function processJob(job, env, options = {}) {
  if (job.version === 3) return processContentJob(job, env, options);
  if (job.kind === 'issue_comment') return processComment(job, env, options);
  return processPullRequest(job, env, options);
}

async function verifySignature(rawBody, header, secret) {
  if (!secret || !/^sha256=[0-9a-fA-F]{64}$/.test(header || '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const received = Uint8Array.from(header.slice(7).match(/.{2}/g), pair => parseInt(pair, 16));
  // WebCrypto performs signature verification rather than comparing strings with ==.
  return crypto.subtle.verify('HMAC', key, received, encoder.encode(rawBody));
}

async function processPullRequest(job, env, options = {}) {
  const { owner, repo, number, installationId } = job;
  const token = await getInstallationToken(env, installationId);
  // Fetch current PR metadata, so queued edit events don't translate stale webhook data.
  const pr = await github(token, `/repos/${owner}/${repo}/pulls/${number}`);
  if (pr.state !== 'open') {
    console.info('PR translation skipped: PR is closed');
    return;
  }
  if (pr.base?.repo?.private && env.ALLOW_PRIVATE !== 'true') {
    console.info('PR translation skipped: private repository');
    return;
  }

  const title = pr.title || '';
  const originalBody = pr.body || '';
  const truncated = originalBody.length > MAX_DESCRIPTION_CHARS;
  const sourceBody = originalBody.slice(0, MAX_DESCRIPTION_CHARS);
  if (!title.trim() && !sourceBody.trim()) {
    console.info('PR translation skipped: empty PR');
    return;
  }
  const translated = await translate(env, title, sourceBody, options);
  const direction = translated.sourceLanguage === 'zh' ? '中文 → English' : 'English → 中文';
  const note = truncated
    ? `\n\n> Note: Only the first ${MAX_DESCRIPTION_CHARS} characters of the PR description were translated.\n`
    : '';
  const comment = `${MARKER}\n### Automatic translation · ${direction}\n\n**${translated.title}**\n\n${translated.body || '_No description_'}${note}\n\n---\n<sub>Generated automatically by PR Translator Bot. Original PR text remains unchanged.</sub>`;

  const existing = await findBotComment(token, owner, repo, number);
  if (existing) {
    // Avoid notifying watchers again when the translation did not change.
    if (existing.body !== comment) {
      await github(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, 'PATCH', { body: comment });
      console.info('PR translation comment updated');
    } else {
      console.info('PR translation comment unchanged');
    }
  } else {
    await github(token, `/repos/${owner}/${repo}/issues/${number}/comments`, 'POST', { body: comment });
    console.info('PR translation comment created');
  }
}

async function getSourceComment(token, owner, repo, commentId) {
  try {
    return await github(token, `/repos/${owner}/${repo}/issues/comments/${commentId}`);
  } catch (error) {
    if (error instanceof GitHubFailure && error.status === 404) return null;
    throw error;
  }
}

function belongsToPullRequest(comment, owner, repo, number, commentId) {
  if (comment?.id !== commentId || typeof comment?.issue_url !== 'string') return false;
  try {
    const issueUrl = new URL(comment.issue_url);
    return issueUrl.origin === GITHUB_API
      && issueUrl.pathname.toLowerCase() === `/repos/${owner}/${repo}/issues/${number}`.toLowerCase();
  } catch {
    return false;
  }
}

function canTranslateComment(pr, env) {
  if (pr.state !== 'open') {
    console.info('PR comment translation skipped: PR is closed');
    return false;
  }
  if (pr.base?.repo?.private && env.ALLOW_PRIVATE !== 'true') {
    console.info('PR comment translation skipped: private repository');
    return false;
  }
  return true;
}

async function processComment(job, env, options = {}) {
  const { owner, repo, number, installationId, commentId } = job;
  const token = await getInstallationToken(env, installationId);
  const prPath = `/repos/${owner}/${repo}/pulls/${number}`;
  const pr = await github(token, prPath);
  if (!canTranslateComment(pr, env)) return;

  const source = await getSourceComment(token, owner, repo, commentId);
  if (!source) {
    console.info('PR comment translation skipped: original comment deleted');
    return;
  }
  if (!belongsToPullRequest(source, owner, repo, number, commentId)) {
    console.info('PR comment translation skipped: original comment belongs to another issue');
    return;
  }
  const originalBody = typeof source.body === 'string' ? source.body : '';
  if (isTranslationComment(originalBody) || isOwnAppComment(source, env)) {
    console.info('PR comment translation skipped: translation comment');
    return;
  }
  if (!originalBody.trim()) {
    console.info('PR comment translation skipped: empty original comment');
    return;
  }
  const truncated = originalBody.length > MAX_DESCRIPTION_CHARS;
  const translated = await translate(env, '', originalBody.slice(0, MAX_DESCRIPTION_CHARS), options);

  // An edit arriving during translation must not publish a superseded version.
  const currentSource = await getSourceComment(token, owner, repo, commentId);
  if (!currentSource) {
    console.info('PR comment translation skipped: original comment deleted');
    return;
  }
  if (!belongsToPullRequest(currentSource, owner, repo, number, commentId)
    || isTranslationComment(currentSource.body) || isOwnAppComment(currentSource, env)) {
    console.info('PR comment translation skipped: original comment no longer eligible');
    return;
  }
  if (currentSource.body !== originalBody) {
    throw new GitHubFailure('Original PR comment changed during translation; retrying current text', true);
  }
  if (!canTranslateComment(await github(token, prPath), env)) return;

  const direction = translated.sourceLanguage === 'zh' ? '中文 → English' : 'English → 中文';
  const marker = `${COMMENT_MARKER_PREFIX}${commentId} -->`;
  const sourceUrl = `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${commentId}`;
  const note = truncated
    ? `\n\n> Note: Only the first ${MAX_DESCRIPTION_CHARS} characters of the original comment were translated.\n`
    : '';
  const comment = `${marker}\n### Automatic comment translation · ${direction}\n\n[Original comment](${sourceUrl})\n\n${translated.body}${note}\n\n---\n<sub>Generated automatically by PR Translator Bot. Original comment remains unchanged.</sub>`;
  const existing = await findBotComment(token, owner, repo, number, marker);
  if (existing) {
    if (existing.body !== comment) {
      await github(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, 'PATCH', { body: comment });
      console.info('PR comment translation comment updated');
    } else {
      console.info('PR comment translation comment unchanged');
    }
  } else {
    await github(token, `/repos/${owner}/${repo}/issues/${number}/comments`, 'POST', { body: comment });
    console.info('PR comment translation comment created');
  }
}

// Export pure helpers for local tests only (Cloudflare runtime ignores these exports).
export { verifySignature, createAppJwt };
