import { translate, translateItems } from './translation.js';
import { GitHubFailure, getInstallationToken, github, findBotComment, findBotReviewComment } from './github.js';

const GITHUB_API = 'https://api.github.com';
const MAX_CONTENT_CHARS = 12000;
const TRANSLATION_MARKER_PREFIX = '<!-- pr-translator-bot:';
const SOURCE_KINDS = new Set(['issue', 'issue_comment', 'review', 'review_comment']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function isOwnTranslation(source, env) {
  const appId = source?.performed_via_github_app?.id;
  return text(source?.body).trimStart().startsWith(TRANSLATION_MARKER_PREFIX)
    || (appId !== undefined && appId !== null
      && env.GITHUB_APP_ID !== undefined && env.GITHUB_APP_ID !== null
      && String(appId) === String(env.GITHUB_APP_ID));
}

function belongsToApiPath(value, expectedPath) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === GITHUB_API
      && url.pathname.toLowerCase() === expectedPath.toLowerCase();
  } catch {
    return false;
  }
}

function sourceMatches(source, job) {
  if (!source || typeof source !== 'object') return false;
  const { owner, repo, number, sourceId, kind } = job;
  if (kind === 'issue') return source.number === number && !source.pull_request;
  if (source.id !== sourceId) return false;
  if (kind === 'issue_comment') {
    return belongsToApiPath(source.issue_url, `/repos/${owner}/${repo}/issues/${number}`);
  }
  if (kind === 'review_comment') {
    return belongsToApiPath(source.pull_request_url, `/repos/${owner}/${repo}/pulls/${number}`);
  }
  // The review endpoint itself is scoped to this PR. Check its optional HTML
  // association too, but always construct presentation links ourselves.
  if (source.html_url !== undefined && source.html_url !== null) {
    try {
      const url = new URL(source.html_url);
      if (url.origin !== 'https://github.com'
        || url.pathname.toLowerCase() !== `/${owner}/${repo}/pull/${number}`.toLowerCase()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function eligibleSource(source, job, env) {
  if (!sourceMatches(source, job)) {
    console.info('Content translation skipped: original content belongs elsewhere');
    return false;
  }
  if (job.kind !== 'issue' && isOwnTranslation(source, env)) {
    console.info('Content translation skipped: translation comment');
    return false;
  }
  if (job.kind === 'review' && String(source.state).toUpperCase() === 'PENDING') {
    console.info('Content translation skipped: review has not been submitted');
    return false;
  }
  if (job.kind !== 'issue' && !text(source.body).trim()) {
    console.info('Content translation skipped: empty original content');
    return false;
  }
  if (job.kind === 'issue' && !text(source.title).trim() && !text(source.body).trim()) {
    console.info('Content translation skipped: empty issue');
    return false;
  }
  return true;
}

function containerEligible(container, job, env) {
  if (!container || container.state !== 'open') {
    console.info('Content translation skipped: issue or PR is closed or deleted');
    return false;
  }
  if (container.number !== undefined && container.number !== job.number) {
    console.info('Content translation skipped: issue or PR belongs elsewhere');
    return false;
  }
  if ((job.kind === 'issue' || job.kind === 'issue_comment') && container.pull_request) {
    console.info('Content translation skipped: issue is a pull request');
    return false;
  }
  if (container.base?.repo?.private && env.ALLOW_PRIVATE !== 'true') {
    console.info('Content translation skipped: private repository');
    return false;
  }
  return true;
}

function repositoryEligible(repository, env) {
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)
    || typeof repository.private !== 'boolean') {
    throw new GitHubFailure('GitHub repository: missing or invalid visibility metadata', true);
  }
  if (repository.private && env.ALLOW_PRIVATE !== 'true') {
    console.info('Content translation skipped: private repository');
    return false;
  }
  return true;
}

async function getIfPresent(token, path) {
  try {
    return await github(token, path);
  } catch (error) {
    if (error instanceof GitHubFailure && error.status === 404) return null;
    throw error;
  }
}

function pathsFor(job) {
  const { owner, repo, number, sourceId, kind } = job;
  const repository = `/repos/${owner}/${repo}`;
  const container = `${repository}/${kind === 'issue' || kind === 'issue_comment' ? 'issues' : 'pulls'}/${number}`;
  const source = kind === 'issue' ? container
    : kind === 'issue_comment' ? `${repository}/issues/comments/${sourceId}`
      : kind === 'review' ? `${repository}/pulls/${number}/reviews/${sourceId}`
        : `${repository}/pulls/comments/${sourceId}`;
  return { repository, container, source };
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function htmlText(value) {
  return text(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
}

export function sourceContext(job, source) {
  const context = [];
  if (text(source.user?.login)) context.push(`Author: <code>${htmlText(source.user.login)}</code>`);
  if (job.kind === 'review' || job.kind === 'review_comment') {
    const commit = job.kind === 'review_comment' ? source.original_commit_id : source.commit_id;
    if (typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit)) {
      context.push(`[Reviewed commit ${commit.slice(0, 10)}](https://github.com/${job.owner}/${job.repo}/commit/${commit})`);
    }
  }
  if (job.kind === 'review_comment') {
    if (text(source.path)) context.push(`File: <code>${htmlText(source.path)}</code>`);
    // Original coordinates remain associated with the reviewed commit even after new pushes.
    if (positiveId(source.original_line)) {
      const start = positiveId(source.original_start_line) ? `${source.original_start_line}–` : '';
      context.push(`Original line: ${start}${source.original_line}`);
    }
    if (source.line === null && positiveId(source.original_line)) context.push('Outdated location');
    if (positiveId(source.pull_request_review_id)) {
      context.push(`[Review #${source.pull_request_review_id}](https://github.com/${job.owner}/${job.repo}/pull/${job.number}#pullrequestreview-${source.pull_request_review_id})`);
    }
    if (positiveId(source.in_reply_to_id)) {
      context.push(`[Thread](https://github.com/${job.owner}/${job.repo}/pull/${job.number}#discussion_r${source.in_reply_to_id})`);
    }
  }
  return context.length ? `\n\n<sub>${context.join(' · ')}</sub>` : '';
}

function renderTranslation(job, translated, truncated, source) {
  const { kind, owner, repo, number, sourceId } = job;
  const direction = translated.sourceLanguage === 'zh' ? '中文 → English' : 'English → 中文';
  const markerKind = kind === 'issue_comment' ? 'issue-comment'
    : kind === 'review_comment' ? 'review-comment' : kind;
  const marker = kind === 'issue' ? '<!-- pr-translator-bot:issue:v1 -->'
    : `<!-- pr-translator-bot:${markerKind}:v1:${sourceId} -->`;
  let heading;
  let content;
  let originalLabel;
  if (kind === 'issue') {
    heading = 'Automatic issue translation';
    content = `**${translated.title}**\n\n${translated.body || '_No description_'}`;
    originalLabel = 'issue description';
  } else {
    const isReview = kind === 'review';
    heading = isReview ? 'Automatic review translation'
      : kind === 'review_comment' ? 'Automatic review comment translation' : 'Automatic comment translation';
    const anchor = isReview ? `pullrequestreview-${sourceId}`
      : kind === 'review_comment' ? `discussion_r${sourceId}` : `issuecomment-${sourceId}`;
    const containerType = kind === 'issue_comment' ? 'issues' : 'pull';
    const sourceUrl = `https://github.com/${owner}/${repo}/${containerType}/${number}#${anchor}`;
    content = `[${isReview ? 'Original review' : 'Original comment'}](${sourceUrl})${sourceContext(job, source)}\n\n${translated.body}`;
    originalLabel = isReview ? 'review' : 'comment';
  }
  const note = truncated
    ? `\n\n> Note: Only the first ${MAX_CONTENT_CHARS} characters of the original ${originalLabel} were translated.\n`
    : '';
  return {
    marker,
    body: `${marker}\n### ${heading} · ${direction}\n\n${content}${note}\n\n---\n<sub>Generated automatically by PR Translator Bot. Original text remains unchanged.</sub>`,
  };
}

export async function processContentJob(job, env, options = {}) {
  if (!SOURCE_KINDS.has(job.kind)) throw new Error('Invalid content translation kind');
  if (job.version === 4) return processNativeReviewJob(job, env, options);
  const { owner, repo, number, installationId, kind } = job;
  const paths = pathsFor(job);
  const token = await getInstallationToken(env, installationId, { requirePullRequestsWrite: kind === 'review_comment' });
  if (!repositoryEligible(await github(token, paths.repository), env)) return;
  const container = await getIfPresent(token, paths.container);
  if (!containerEligible(container, job, env)) return;
  const source = kind === 'issue' ? container : await getIfPresent(token, paths.source);
  if (!source) {
    console.info('Content translation skipped: original content deleted');
    return;
  }
  if (!eligibleSource(source, job, env)) return;
  const originalTitle = kind === 'issue' ? text(source.title) : '';
  const originalBody = text(source.body);
  const translated = await translate(env, originalTitle, originalBody.slice(0, MAX_CONTENT_CHARS), options);

  // Edits, deletion, closure, and a change to private visibility must be checked
  // again after a provider call, which can outlast several incoming webhooks.
  const currentSource = await getIfPresent(token, paths.source);
  if (!currentSource) {
    console.info('Content translation skipped: original content deleted');
    return;
  }
  if (!eligibleSource(currentSource, job, env)) return;
  if (currentSource.id !== source.id || text(currentSource.body) !== originalBody
    || (kind === 'issue' && text(currentSource.title) !== originalTitle)) {
    throw new GitHubFailure('Original content changed during translation; retrying current text', true);
  }
  const currentContainer = kind === 'issue' ? currentSource : await getIfPresent(token, paths.container);
  if (!containerEligible(currentContainer, job, env)) return;
  if (!repositoryEligible(await github(token, paths.repository), env)) return;

  const comment = renderTranslation(job, translated, originalBody.length > MAX_CONTENT_CHARS, currentSource);
  if (kind === 'review_comment') {
    const rootId = positiveId(currentSource.in_reply_to_id) ? currentSource.in_reply_to_id : job.sourceId;
    if (rootId !== job.sourceId) {
      const root = await getIfPresent(token, `/repos/${owner}/${repo}/pulls/comments/${rootId}`);
      if (!sourceMatches(root, { ...job, sourceId: rootId }) || positiveId(root.in_reply_to_id)) {
        console.info('Content translation skipped: review thread is missing or belongs elsewhere');
        return;
      }
    }
    const threadTranslation = await findBotReviewComment(token, owner, repo, number, comment.marker, rootId);
    if (threadTranslation) {
      if (threadTranslation.body !== comment.body) {
        await github(token, `/repos/${owner}/${repo}/pulls/comments/${threadTranslation.id}`, 'PATCH', { body: comment.body });
        console.info('Review thread translation updated');
      } else console.info('Review thread translation unchanged');
      return;
    }
    // Existing releases posted inline translations into Conversation. Keep updating
    // those in place; migration must not duplicate or delete published comments.
    const legacyTranslation = await findBotComment(token, owner, repo, number, comment.marker);
    if (legacyTranslation) {
      if (legacyTranslation.body !== comment.body) {
        await github(token, `/repos/${owner}/${repo}/issues/comments/${legacyTranslation.id}`, 'PATCH', { body: comment.body });
        console.info('Legacy review translation updated');
      } else console.info('Legacy review translation unchanged');
      return;
    }
    await github(token, `/repos/${owner}/${repo}/pulls/${number}/comments/${rootId}/replies`, 'POST', { body: comment.body });
    console.info('Review thread translation created');
    return;
  }
  const existing = await findBotComment(token, owner, repo, number, comment.marker);
  if (existing) {
    if (existing.body !== comment.body) {
      await github(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, 'PATCH', { body: comment.body });
      console.info('Content translation comment updated');
    } else {
      console.info('Content translation comment unchanged');
    }
  } else {
    await github(token, `/repos/${owner}/${repo}/issues/${number}/comments`, 'POST', { body: comment.body });
    console.info('Content translation comment created');
  }
}

const nativeReviewMarker = id => `<!-- pr-translator-bot:review:v2:${id} -->`;
const nativeCommentMarker = id => `<!-- pr-translator-bot:review-comment:v2:${id} -->`;
const nativeReplyMarker = id => `<!-- pr-translator-bot:review-reply:v1:${id} -->`;

async function listAll(token, path) {
  const results = [];
  for (let page = 1; page <= 5; page++) {
    const values = await github(token, `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(values)) throw new GitHubFailure('GitHub review list: invalid response', true);
    results.push(...values);
    if (values.length < 100) return results;
  }
  throw new GitHubFailure('Review lookup exceeds 500 entries', false);
}

async function sourceHash(source) {
  const value = JSON.stringify({ id: source.id, body: text(source.body), author: text(source.user?.login),
    commit: source.commit_id, originalCommit: source.original_commit_id, path: source.path,
    line: source.line, startLine: source.start_line, originalLine: source.original_line,
    originalStartLine: source.original_start_line, side: source.side, startSide: source.start_side,
    reply: source.in_reply_to_id, review: source.pull_request_review_id });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function addHash(body, hash) {
  return body.replace('\n', `\n<!-- pr-translator-bot:source:v1:${hash} -->\n`);
}

function hasHash(body, hash) {
  return text(body).split('\n')[1] === `<!-- pr-translator-bot:source:v1:${hash} -->`;
}

async function expandReviewComments(token, job, reviewId, compact, index = { values: new Map(), page: 1, complete: false }) {
  if (!compact.length) return [];
  const wanted = new Set();
  for (const source of compact) {
    if (!positiveId(source.id) || source.pull_request_review_id !== reviewId
      || !sourceMatches(source, { ...job, kind: 'review_comment', sourceId: source.id })) {
      throw new GitHubFailure('Review comment association is invalid', false);
    }
    if (wanted.has(source.id)) throw new GitHubFailure('GitHub review list contains duplicate IDs', true);
    wanted.add(source.id);
  }
  // Review-scoped lists omit line/side/thread fields. Match their IDs against
  // the complete PR comment representation; never infer coordinates or parents.
  const resolved = () => Array.from(wanted).every(id => index.values.has(id));
  while (!resolved() && !index.complete && index.page <= 5) {
    const values = await github(token,
      `/repos/${job.owner}/${job.repo}/pulls/${job.number}/comments?per_page=100&page=${index.page++}`);
    if (!Array.isArray(values)) throw new GitHubFailure('GitHub PR comment list: invalid response', true);
    for (const source of values) {
      if (positiveId(source.id)) index.values.set(source.id, source);
    }
    if (values.length < 100) index.complete = true;
  }
  if (!resolved()) {
    if (index.complete) throw new GitHubFailure('Review comment changed or was deleted during lookup; retrying', true);
    throw new GitHubFailure('Review comment metadata lookup exceeds 500 PR comments', false);
  }
  return compact.map(source => {
    const full = index.values.get(source.id);
    if (full.pull_request_review_id !== reviewId
      || !sourceMatches(full, { ...job, kind: 'review_comment', sourceId: source.id })) {
      throw new GitHubFailure('Expanded review comment association is invalid', false);
    }
    return full;
  });
}

async function readNativeSnapshot(token, job, env) {
  const base = `/repos/${job.owner}/${job.repo}`;
  if (!repositoryEligible(await github(token, base), env)) return null;
  const container = await getIfPresent(token, `${base}/pulls/${job.number}`);
  if (!containerEligible(container, job, env)) return null;
  const review = await getIfPresent(token, `${base}/pulls/${job.number}/reviews/${job.sourceId}`);
  if (!sourceMatches(review, job) || isOwnTranslation(review, env)
    || String(review.state).toUpperCase() === 'PENDING') return null;
  if (!/^[a-f0-9]{40}$/i.test(text(review.commit_id))) {
    throw new GitHubFailure('Source review has no valid reviewed commit', false);
  }
  const compact = await listAll(token, `${base}/pulls/${job.number}/reviews/${job.sourceId}/comments`);
  const values = await expandReviewComments(token, job, job.sourceId, compact);
  const roots = [];
  for (const source of values) {
    if (!positiveId(source.id) || !sourceMatches(source, { ...job, kind: 'review_comment', sourceId: source.id })
      || source.pull_request_review_id !== job.sourceId) {
      throw new GitHubFailure('Source review comment association is invalid', false);
    }
    if (!positiveId(source.in_reply_to_id) && !isOwnTranslation(source, env) && text(source.body).trim()) roots.push(source);
  }
  roots.sort((a, b) => a.id - b.id);
  if (roots.length > 100) throw new GitHubFailure('Source review exceeds 100 inline comments', false);
  return { review, roots };
}

async function snapshotKey(snapshot) {
  return JSON.stringify([await sourceHash(snapshot.review), ...await Promise.all(snapshot.roots.map(sourceHash))]);
}

async function nativeTranslations(token, job, env) {
  const base = `/repos/${job.owner}/${job.repo}/pulls/${job.number}`;
  const reviews = (await listAll(token, `${base}/reviews`)).filter(review => review.user?.type === 'Bot'
    && (text(review.body).startsWith(nativeReviewMarker(job.sourceId))
      || text(review.body).startsWith(`<!-- pr-translator-bot:review-supplement:v1:${job.sourceId}:`)));
  const comments = new Map();
  const commentIndex = { values: new Map(), page: 1, complete: false };
  for (const review of reviews) {
    const reviewAppId = review.performed_via_github_app?.id;
    if (!positiveId(review.id) || !sourceMatches(review, { ...job, kind: 'review', sourceId: review.id })
      || (reviewAppId !== undefined && String(reviewAppId) !== String(env.GITHUB_APP_ID))) {
      throw new GitHubFailure('Translation review association is invalid', false);
    }
    const compact = await listAll(token, `${base}/reviews/${review.id}/comments`);
    for (const comment of await expandReviewComments(token, job, review.id, compact, commentIndex)) {
      if (comment.user?.type !== 'Bot' || positiveId(comment.in_reply_to_id)) continue;
      const match = text(comment.body).match(/^<!-- pr-translator-bot:review-comment:v2:(\d+) -->\n/);
      if (match) {
        const commentAppId = comment.performed_via_github_app?.id;
        if (!positiveId(comment.id) || comment.pull_request_review_id !== review.id
          || !positiveId(Number(match[1]))
          || !sourceMatches(comment, { ...job, kind: 'review_comment', sourceId: comment.id })
          || (commentAppId !== undefined && String(commentAppId) !== String(env.GITHUB_APP_ID))) {
          throw new GitHubFailure('Translation review comment association is invalid', false);
        }
        comments.set(Number(match[1]), comment);
      }
    }
  }
  return { reviews, comments, main: reviews.find(review => text(review.body).startsWith(nativeReviewMarker(job.sourceId))) };
}

function renderNativeReview(job, source, translated, hash) {
  const rendered = translated
    ? renderTranslation(job, translated, text(source.body).length > MAX_CONTENT_CHARS, source).body
    : `<!-- pr-translator-bot:review:v1:${job.sourceId} -->\n### Automatic review translation\n\n[Original review](https://github.com/${job.owner}/${job.repo}/pull/${job.number}#pullrequestreview-${job.sourceId})${sourceContext(job, source)}\n\n_行内译文见下方 / Inline translations below._`;
  return addHash(rendered.replace(`<!-- pr-translator-bot:review:v1:${job.sourceId} -->`, nativeReviewMarker(job.sourceId)), hash);
}

function renderNativeComment(job, source, translated, hash) {
  const rendered = renderTranslation({ ...job, kind: 'review_comment', sourceId: source.id }, translated,
    text(source.body).length > MAX_CONTENT_CHARS, source).body;
  return addHash(rendered.replace(`<!-- pr-translator-bot:review-comment:v1:${source.id} -->`, nativeCommentMarker(source.id)), hash);
}

function reviewCoordinates(source, commit) {
  if (source.original_commit_id !== commit || !text(source.path) || !positiveId(source.original_line)
    || !['LEFT', 'RIGHT'].includes(source.side)) {
    throw new GitHubFailure('Original review location cannot be copied safely', false);
  }
  if (positiveId(source.original_start_line) && (source.original_start_line > source.original_line
    || (source.original_start_line !== source.original_line && !['LEFT', 'RIGHT'].includes(source.start_side)))) {
    throw new GitHubFailure('Original review line range cannot be copied safely', false);
  }
  return { path: source.path, line: source.original_line, side: source.side,
    ...(positiveId(source.original_start_line) && source.original_start_line !== source.original_line
      ? { start_line: source.original_start_line, start_side: source.start_side || source.side } : {}) };
}

async function syncNativeReview(token, job, env, options) {
  const snapshot = await readNativeSnapshot(token, job, env);
  if (!snapshot || (!text(snapshot.review.body).trim() && !snapshot.roots.length)) return null;
  const state = await nativeTranslations(token, job, env);
  if (state.reviews.some(review => review.commit_id !== snapshot.review.commit_id)) {
    throw new GitHubFailure('Translation review commit does not match its source', false);
  }
  const reviewHash = await sourceHash(snapshot.review);
  const hashes = new Map(await Promise.all(snapshot.roots.map(async source => [source.id, await sourceHash(source)])));
  const needsBody = !state.main || !hasHash(state.main.body, reviewHash);
  const changedRoots = snapshot.roots.filter(source => !hasHash(state.comments.get(source.id)?.body, hashes.get(source.id)));
  const items = [
    ...(needsBody && text(snapshot.review.body).trim() ? [{ id: 'review', title: '', body: text(snapshot.review.body).slice(0, MAX_CONTENT_CHARS) }] : []),
    ...changedRoots.map(source => ({ id: String(source.id), title: '', body: text(source.body).slice(0, MAX_CONTENT_CHARS) })),
  ];
  const translated = new Map((items.length ? await translateItems(env, items, options) : []).map(item => [item.id, item]));
  const current = await readNativeSnapshot(token, job, env);
  if (!current) return null;
  if (await snapshotKey(snapshot) !== await snapshotKey(current)) {
    throw new GitHubFailure('Original review changed during translation; retrying current text', true);
  }
  const base = `/repos/${job.owner}/${job.repo}/pulls/${job.number}`;
  const body = needsBody ? renderNativeReview(job, current.review, translated.get('review'), reviewHash) : state.main.body;
  const missingRoots = changedRoots.filter(source => !state.comments.has(source.id));
  const newComments = missingRoots.map(source => ({ ...reviewCoordinates(source, current.review.commit_id),
    body: renderNativeComment(job, source, translated.get(String(source.id)), hashes.get(source.id)) }));
  // COMMENT preserves the original review decision; the bot is providing translations.
  if (!state.main) {
    const created = await github(token, `${base}/reviews`, 'POST', { event: 'COMMENT', commit_id: current.review.commit_id, body, comments: newComments });
    if (!positiveId(created?.id)) throw new GitHubFailure('Created translation review has no valid ID', true);
    console.info('Native translation review created');
  } else {
    if (needsBody && state.main.body !== body) {
      await github(token, `${base}/reviews/${state.main.id}`, 'PUT', { body });
      console.info('Native translation review updated');
    }
    for (const source of changedRoots.filter(value => state.comments.has(value.id))) {
      const existing = state.comments.get(source.id);
      const commentBody = renderNativeComment(job, source, translated.get(String(source.id)), hashes.get(source.id));
      if (existing.body !== commentBody) await github(token, `/repos/${job.owner}/${job.repo}/pulls/comments/${existing.id}`, 'PATCH', { body: commentBody });
    }
    if (newComments.length) {
      // Submitted Reviews cannot gain new root comments. A delayed source comment
      // receives a separate, explicitly linked supplement authored by this bot.
      const suffix = (await sourceHash({ id: job.sourceId, body: missingRoots.map(source => source.id).join(',') })).slice(0, 16);
      const supplement = `<!-- pr-translator-bot:review-supplement:v1:${job.sourceId}:${suffix} -->\n\n${body}`;
      await github(token, `${base}/reviews`, 'POST', { event: 'COMMENT', commit_id: current.review.commit_id, body: supplement, comments: newComments });
      console.info('Native translation review supplement created');
    }
  }
  return nativeTranslations(token, job, env);
}

async function processNativeReviewJob(job, env, options) {
  const { owner, repo, number, installationId } = job;
  const token = await getInstallationToken(env, installationId, { requirePullRequestsWrite: true });
  if (job.kind === 'review') return syncNativeReview(token, job, env, options);
  const base = `/repos/${owner}/${repo}`;
  // Check visibility before fetching or sending any comment text.
  if (!repositoryEligible(await github(token, base), env)
    || !containerEligible(await getIfPresent(token, `${base}/pulls/${number}`), job, env)) return;
  const source = await getIfPresent(token, `${base}/pulls/comments/${job.sourceId}`);
  if (!source || !eligibleSource(source, job, env)) return;
  const rootId = positiveId(source.in_reply_to_id) ? source.in_reply_to_id : source.id;
  const root = rootId === source.id ? source : await getIfPresent(token, `${base}/pulls/comments/${rootId}`);
  if (!sourceMatches(root, { ...job, sourceId: rootId }) || positiveId(root.in_reply_to_id)
    || isOwnTranslation(root, env) || !positiveId(root.pull_request_review_id)) return;
  const reviewJob = { ...job, kind: 'review', sourceId: root.pull_request_review_id };
  const state = await syncNativeReview(token, reviewJob, env, options);
  if (source.id === rootId || !state) return;
  const translatedRoot = state.comments.get(rootId);
  if (!translatedRoot || !positiveId(translatedRoot.id)) throw new GitHubFailure('Translated review thread is not available', true);
  const marker = nativeReplyMarker(source.id);
  const hash = await sourceHash(source);
  const existing = await findBotReviewComment(token, owner, repo, number, marker, translatedRoot.id);
  if (existing && hasHash(existing.body, hash)) return;
  const translated = await translate(env, '', text(source.body).slice(0, MAX_CONTENT_CHARS), options);
  const current = await getIfPresent(token, `${base}/pulls/comments/${source.id}`);
  const currentRoot = await getIfPresent(token, `${base}/pulls/comments/${rootId}`);
  if (!current || !eligibleSource(current, job, env) || !sourceMatches(currentRoot, { ...job, sourceId: rootId })
    || isOwnTranslation(currentRoot, env)) return;
  if (await sourceHash(current) !== hash || await sourceHash(currentRoot) !== await sourceHash(root)
    || currentRoot.pull_request_review_id !== root.pull_request_review_id || positiveId(currentRoot.in_reply_to_id)
    || current.in_reply_to_id !== rootId) throw new GitHubFailure('Original review reply changed during translation; retrying current text', true);
  if (!repositoryEligible(await github(token, base), env)
    || !containerEligible(await getIfPresent(token, `${base}/pulls/${number}`), job, env)) return;
  const rendered = renderTranslation(job, translated, text(current.body).length > MAX_CONTENT_CHARS, current).body;
  const body = addHash(rendered.replace(`<!-- pr-translator-bot:review-comment:v1:${source.id} -->`, marker), hash);
  if (existing) await github(token, `${base}/pulls/comments/${existing.id}`, 'PATCH', { body });
  else await github(token, `${base}/pulls/${number}/comments/${translatedRoot.id}/replies`, 'POST', { body });
  console.info('Native review reply translation saved');
}
