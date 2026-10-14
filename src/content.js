import { translate } from './translation.js';
import { GitHubFailure, getInstallationToken, github, findBotComment } from './github.js';

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

function renderTranslation(job, translated, truncated) {
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
    content = `[${isReview ? 'Original review' : 'Original comment'}](${sourceUrl})\n\n${translated.body}`;
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
  const { owner, repo, number, installationId, kind } = job;
  const paths = pathsFor(job);
  const token = await getInstallationToken(env, installationId);
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

  const comment = renderTranslation(job, translated, originalBody.length > MAX_CONTENT_CHARS);
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
