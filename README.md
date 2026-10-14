# PR Translator Bot

**English** · [简体中文](README.zh-CN.md)

Translate GitHub PR and Issue titles, descriptions, discussion comments, inline review comments, and Review bodies between Chinese and English. Translations appear as separate comments in the corresponding PR or Issue discussion.

The bot runs as a **GitHub App on Cloudflare Workers**, with Cloudflare Queues for background processing and bounded retries. Configure Gemini, OpenAI-compatible APIs, OpenAI Responses, or Anthropic, with multiple sites and models in a priority list. When a provider fails or runs out of quota, the bot tries the next entry. Install the App once for the repositories you want to cover; no repository-level GitHub Actions workflows are needed.

## Contents

- [Quick start and everyday use](#quick-start-and-everyday-use)
- [What it does](#what-it-does)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Local development and tests](#local-development-and-tests)
- [Costs and translation providers](#costs-and-translation-providers)
- [Troubleshooting](#troubleshooting)
- [Security and limitations](#security-and-limitations)
- [Publishing to GitHub](#publishing-to-github)
- [Project structure](#project-structure)
- [License](#license)

## Quick start and everyday use

You deploy your own Worker and GitHub App. Download a release's source archive, or replace `<repository-url>` with this repository's clone URL and run:

```sh
git clone <repository-url> pr-translator-bot
cd pr-translator-bot
npm ci
```

If you downloaded a source archive, extract it, open a terminal in the directory containing `package.json`, and run `npm ci`.

Then complete these steps once:

1. **Create your local configuration.** In PowerShell, run `Copy-Item wrangler.example.toml wrangler.toml`; in Bash, run `cp wrangler.example.toml wrangler.toml`. Set `TARGET_OWNER` to the GitHub user or organization that owns the target repositories. For a relay or multiple APIs, configure the URL, model, protocol, and API-key secret names using [the provider setup](#multiple-api-sites-and-models). Keep `ALLOW_PRIVATE = "false"` unless you intend to translate private content. The default setup uses Gemini.
2. **Deploy the Worker and queues.** Run the following commands, then save the Worker URL printed by Wrangler:

   ```sh
   npx wrangler login
   npx wrangler queues create pr-translator-jobs
   npx wrangler queues create pr-translator-dead-letter
   npm run deploy
   ```

   For an existing deployment, create only queues that do not already exist. See [deployment step 2](#2-create-the-queues-and-deploy-the-worker) if you change their names.
3. **Register a GitHub App.** Enable its webhook, enter `<WORKER_URL>/webhook`, and generate a webhook secret. Grant **Issues → Read and write** and **Pull requests → Read-only**. Subscribe to all five events: **Pull request**, **Issues**, **Issue comment**, **Pull request review**, and **Pull request review comment**. Record the App ID and download its private key. [Deployment step 3](#3-register-the-github-app) describes the form and existing-installation permission updates.
4. **Save the credentials to Cloudflare.** Add `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_PRIVATE_KEY` as Worker secrets. The private key must be a complete PKCS#8 PEM; follow [private-key preparation](#4-prepare-the-private-key) and the shell-specific upload commands in [deployment step 5](#5-configure-worker-secrets). Add `GEMINI_API_KEY` for the default setup, or every secret named by `api_key_env` in your provider list. Enter keys when Wrangler prompts, rather than putting them in your configuration or command history. For example:

   ```sh
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GEMINI_API_KEY
   ```

5. **Install the App on your target repositories.** Open the App's **Install App** page and select repositories owned by `TARGET_OWNER`. Create a PR or Issue with some Chinese or English text and check for a separate translation comment. [Verification steps](#7-verify-a-translation) cover the other content types.

After setup, use GitHub normally. Creating or editing an **open PR or Issue** translates its title and description; adding or editing a discussion comment creates or updates that source's translation. Submitting or editing a Review body, or creating or editing an inline PR review comment, also produces a translation in the PR **Conversation**. The original content remains unchanged. Existing history is not translated automatically; edit an old source to trigger its own translation.

The deployed bot runs on Cloudflare. You do not need to keep a local terminal open. `npm run tail` is optional for watching logs; `Ctrl+C` stops log viewing. To apply source or `wrangler.toml` changes, run `npm run deploy`. Publishing a GitHub Release does not deploy your Worker.

## What it does

- Translates **PR and Issue titles and descriptions**, leaving the original text unchanged.
- Translates new or edited **discussion comments** on PRs and Issues, **inline PR review comments**, and **submitted or edited Review bodies**, including content written by other bots. Each source has its own translation comment with a link to the original; editing the source updates that translation.
- Asks the translation model to detect the dominant language: primarily Chinese → English; otherwise → Simplified Chinese.
- Supports multiple API sites, models, and API keys with ordered failover within each translation request.
- Handles `pull_request` actions `opened`, `edited`, `reopened`, and `ready_for_review`. Draft PRs are also eligible; pushing commits alone (`synchronize`) does not trigger translation.
- Handles `issues` actions `opened`, `edited`, and `reopened`; `issue_comment` and `pull_request_review_comment` actions `created` and `edited`; and `pull_request_review` actions `submitted` and `edited`. Empty or pending Review bodies are skipped.
- Fetches the current PR or Issue and the relevant source from GitHub before translating. Only open PRs and Issues are processed. The bot's own author identity and translation markers prevent translation loops, including when someone edits a translation.
- Persists each accepted job in a queue, retries temporary failures, and checks the installation's comment permissions before calling a translation API.
- Reuses a marked bot comment for each PR or Issue title/description and a separate marked comment for each source comment or Review, updating only when the generated comment changes. Concurrent deliveries can still create duplicates; see [limitations](#security-and-limitations).
- Processes only the configured repository owner and skips private repositories by default.

For a PR titled “修复 Markdown 分页问题”, a translation comment might look like this:

> ### Automatic translation · 中文 → English
>
> **Fix Markdown pagination issues**
>
> Fixed an issue where nested list items appeared too early during manual pagination.
>
> *Generated automatically by PR Translator Bot. Original PR text remains unchanged.*

Code diffs themselves, commit comments, and GitHub Discussions are outside the supported scope.

### Comments and Reviews

After enabling the corresponding webhook events, creating or editing a discussion or inline review comment, or submitting or editing a Review body, triggers a translation on an open PR or Issue. Content authored by other GitHub Apps is eligible. Each translation is a separate ordinary discussion comment linked to its source. Inline comment and Review translations appear in the PR **Conversation**, so they are easy to find alongside other translations. The original text and review state remain unchanged. Editing a source updates its own translation without replacing other translations.

Existing history is not translated automatically. To translate older content, edit that source after enabling its event, or redeliver an available supported delivery for that source. A `pull_request` or `issues` event translates the title and description; comments require `issue_comment`, inline comments require `pull_request_review_comment`, and Review bodies require `pull_request_review`.

The consumer verifies that the fetched source belongs to the expected PR or Issue, skips missing or empty sources, and checks again before publishing. If source text changes during translation, a queue retry uses its latest content. Deleting a source does not automatically delete a translation that was already published.

```text
GitHub PR/Issue/comment/Review event → verify webhook signature → persist compact queue job → 202 accepted
Queue consumer → check installation permissions → fetch current PR or Issue and relevant source
→ try translation providers in order → create or update translation comment
Temporary failure → bounded delayed retry; permanent/exhausted failure → dead-letter queue
```

## Deployment

### Prerequisites

- Node.js and npm. Use a currently supported Node.js LTS release, such as Node.js 22 or 24; check [Wrangler system requirements](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
- A Cloudflare account with Workers enabled.
- A GitHub account with permission to register and install a GitHub App.
- At least one API key with model access and available quota: Gemini, an OpenAI-compatible service, OpenAI Responses, or Anthropic. The default single-provider setup uses a [Gemini API key from Google AI Studio](https://aistudio.google.com/app/apikey); check [supported regions](https://ai.google.dev/gemini-api/docs/available-regions).
- OpenSSL available in your terminal for private-key conversion. Windows does not include it by default.

### 1. Prepare the project

Open a terminal in the project directory, where `package.json` is located:

```sh
npm ci
```

Copy the public configuration template to your local `wrangler.toml`:

**Bash / Git Bash:**

```bash
cp wrangler.example.toml wrangler.toml
```

**Windows PowerShell:**

```powershell
Copy-Item wrangler.example.toml wrangler.toml
```

Review [wrangler.example.toml](wrangler.example.toml) and edit your local copy. **Required:** replace `TARGET_OWNER = "your-github-owner"` with the GitHub user or organization that owns the repositories you want to translate. Change `name` if you want a different Worker name. The template includes queue bindings, a 60-second translation budget, and three delayed retries. Keep private repositories disabled unless you intend to send their supported content to the configured providers. Your actual `wrangler.toml` is ignored by Git; publish the placeholder template instead. For multiple APIs, follow [provider configuration](#multiple-api-sites-and-models).

### 2. Create the queues and deploy the Worker

```sh
npx wrangler login
npx wrangler queues create pr-translator-jobs
npx wrangler queues create pr-translator-dead-letter
npm run deploy
```

Create both queues before the first deployment. The supplied `wrangler.toml` connects the job producer and consumer, and a dead-letter producer, to the same Worker. No second Worker is needed. If you rename a queue, update all matching producer, consumer, and dead-letter queue names in the configuration. For an existing deployment, create only queues that do not already exist.

Save the URL printed by Wrangler, for example:

```text
https://pr-translator-bot.<your-subdomain>.workers.dev
```

Open the root URL. It should return `PR Translator Bot is running`. This checks that the Worker is reachable; it does not validate credentials or translation access.

The webhook endpoint is `<WORKER_URL>/webhook`.

### 3. Register the GitHub App

Generate a webhook secret using Node.js; this command works in both Bash and PowerShell:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the value securely. You will enter the same value in GitHub and Cloudflare.

Open [GitHub App settings](https://github.com/settings/apps) → **New GitHub App**. For an organization, register the App in that organization's settings instead.

Configure:

- **GitHub App name**: a unique name, such as `PR Translator - <unique-suffix>`.
- **Homepage URL**: your Worker root URL or the public project repository URL.
- **Webhook**: enable **Active**; set **Webhook URL** to `<WORKER_URL>/webhook` and **Webhook secret** to the generated value.
- **Repository permissions**: **Pull requests → Read-only**, **Issues → Read and write**, and **Metadata → Read-only** (automatically granted).
- **Subscribe to events**: **Pull request**, **Issues**, **Issue comment**, **Pull request review**, and **Pull request review comment**.
- **Where can this GitHub App be installed?**: **Only on this account** to restrict installation to the account that registered the App.

**Issue comment** covers ordinary discussion comments on both PRs and Issues. **Pull request review comment** covers inline PR review comments and does not replace it.

**Issues → Read and write** covers Issue access and creating or updating ordinary discussion comments through the [issue comments API](https://docs.github.com/en/rest/issues/comments). **Pull requests → Read-only** covers PR, Review, and inline comment access. The [webhook event requirements](https://docs.github.com/en/webhooks/webhook-events-and-payloads) are covered by this configuration. Writing PR discussion comments also accepts **Pull requests → Read and write**, but full Issue support still needs Issues access. Inline translations are ordinary PR discussion comments, so Pull requests write permission is not required for this feature.

For an existing App, deploy this version, enable all five events under **Permissions & events → Subscribe to events**, and save. Keep already enabled events selected. An installation with **Issues → Read and write** and **Pull requests → Read-only** or **Read and write** needs no additional permission for the expanded scope, and its existing Worker secrets remain valid.

If you change permissions after installing the App, the installation account must [approve the new permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app). Open the account's **Settings → Applications → Installed GitHub Apps → Configure** and accept the permission update, or follow GitHub's approval email. Saving the App registration alone does not update an existing installation. Once approved, redeliver a supported event; the bot obtains a fresh installation token for each job, so granting permissions does not require another Worker redeployment.

After creating the App, record its **App ID** and select **Generate a private key** to download a `.pem` file. Use the App ID, not the Client ID or installation ID. OAuth/user authorization is not needed.

GitHub's initial webhook ping may fail until you configure the Worker secrets in step 5.

### 4. Prepare the private key

The Worker requires a PKCS#8 PEM key beginning with `-----BEGIN PRIVATE KEY-----`. If the downloaded key begins with `-----BEGIN RSA PRIVATE KEY-----`, convert it:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in github-app-downloaded.pem -out github-app-pkcs8.pem
```

Replace the input filename with your downloaded PEM filename. This single-line command works in Bash and PowerShell. If your key is already PKCS#8, use it directly in the next step.

### 5. Configure Worker secrets

Run these commands from the project directory and enter each value when prompted:

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

- `GITHUB_APP_ID`: the App ID from step 3.
- `GITHUB_WEBHOOK_SECRET`: exactly the value entered in the GitHub App settings.

Upload `GITHUB_PRIVATE_KEY` from the PKCS#8 file, including its PEM header, footer, and line breaks.

**Bash / Git Bash:**

```bash
npx wrangler secret put GITHUB_PRIVATE_KEY < github-app-pkcs8.pem
```

**Windows PowerShell:**

```powershell
Get-Content -Raw .\github-app-pkcs8.pem | npx wrangler secret put GITHUB_PRIVATE_KEY
```

PowerShell does not support Bash's `< file` input redirection. Wrangler [accepts piped secret input](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put); use the command for your shell. `wrangler secret put` deploys the updated secrets to the Worker named in your configuration.

For the default single-Gemini setup, add its API key:

```sh
npx wrangler secret put GEMINI_API_KEY
```

For multiple providers, add each secret named by `api_key_env` in your actual list. The [relay setup](#multiple-api-sites-and-models) below uses `GEMINI_API_KEY` and `RELAY_API_KEY`. Put API keys in Worker secrets, never in provider JSON or `wrangler.toml`.

### 6. Install the App

In GitHub App settings, open **Install App**, choose the intended account, and select either **All repositories** or **Only select repositories**.

The repositories must belong to `TARGET_OWNER`. Installing on a personal account does not cover repositories owned by other organizations; see [GitHub App installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

### 7. Verify a translation

1. Run `npm run tail` to watch Worker logs.
2. Open a PR with a Chinese title and description in an installed public repository; check for an English translation comment.
3. Change the description and verify that the existing comment is updated when the translation changes.
4. Try a primarily English PR and check for a Simplified Chinese translation.
5. Create an English Conversation comment on the open PR, including one with Markdown links or HTML tags, and check for a separate Chinese translation linked to its source. Edit the source and verify that its existing translation is updated.
6. Open an Issue, edit its title or description, and create or edit a discussion comment. Verify that the Issue's title/description and each comment have separate translations.
7. Submit a PR Review with a nonempty body, and create an inline review comment. Verify that each produces a source-linked translation in the PR Conversation. Edit each source and check that its translation is updated. An empty approval Review has no body to translate.

In GitHub App settings → **Advanced → Recent Deliveries**, inspect the webhook response. **`202 accepted` means the job was persisted in the queue; it does not mean translation succeeded.** Queue processing appears as a separate invocation in `npm run tail`. After fixing a permanent configuration or permission problem, use **Redeliver** on a relevant delivery or edit the source you want translated. `npm run tail` only displays logs; stopping it with `Ctrl+C` does not stop the deployed bot.

## Configuration

Non-secret settings live in your local `wrangler.toml`, created from [wrangler.example.toml](wrangler.example.toml):

- `TARGET_OWNER` — **required**: replace the template value `"your-github-owner"` with a GitHub user or organization name. Only repositories owned by that account are processed; matching is case-insensitive. If this setting is missing or empty, repository events are skipped.
- `GEMINI_MODEL`, default `"gemini-3.5-flash-lite"`: Gemini model ID for the default single-provider setup. Choose a model accessible to your API key that supports structured JSON output. This setting is ignored when a provider list is configured.
- `ALLOW_PRIVATE`, default `"false"`: private repositories are processed only when set to the exact string `"true"`.
- `TRANSLATION_PROVIDERS`, default `""`: a JSON array of translation providers in priority order. A missing or blank value uses the original `GEMINI_MODEL` + `GEMINI_API_KEY` setup, with the entire `TRANSLATION_TIMEOUT_MS` budget available to that single Gemini attempt. An explicit empty array (`[]`) is a configuration error.
- `TRANSLATION_TIMEOUT_MS`: shared translation time budget in milliseconds. The supplied queue configuration uses `"60000"`; queue processing accepts `1000`–`120000` and defaults to `60000` when unset. GitHub authentication, fetching source content, and writing the translation are outside this budget. The optional HTTP background mode defaults to `20000` and accepts only `1000`–`25000`.

After changing these settings, run `npm run deploy`. Each Worker deployment supports one repository owner. Keep the three GitHub credentials and all provider API keys in Worker secrets, outside `wrangler.toml`.

### Multiple API sites and models

Each entry selects an API protocol, site, model, and API-key secret. To add an OpenAI-compatible relay as a backup to Gemini, first obtain the relay's **API prefix URL**, **exact model ID**, and **API key**. Use its API documentation or dashboard; the display name of a model may differ from the ID accepted by the API.

Supported protocol types:

- `gemini`: Gemini `generateContent`; default `base_url` is `https://generativelanguage.googleapis.com/v1beta`.
- `openai`: OpenAI-compatible Chat Completions; default `base_url` is `https://api.openai.com/v1`.
- `openai_responses`: OpenAI Responses; default `base_url` is `https://api.openai.com/v1`.
- `anthropic`: Anthropic Messages; default `base_url` is `https://api.anthropic.com/v1`.

Choose `type` by the **API protocol**, rather than the model's brand. For example, a relay exposing a Gemini or Claude model through OpenAI-compatible Chat Completions still uses `openai`. “OpenAI-compatible” means the site accepts Chat Completions requests and returns that response format. A site that supports only Responses must use `openai_responses`. Other protocols, including DeepL and Google Cloud Translation, require an adapter in [src/translation.js](src/translation.js).

Each entry accepts:

- `name` — required, unique display name for logs, 1–64 characters. Use Chinese/English letters, numbers, spaces, `_`, `.`, or `-`.
- `type` — required, one of the four protocol types above.
- `model` — required, the model ID offered by that site.
- `api_key_env` — required, the Worker secret name holding this entry's API key, such as `RELAY_API_KEY`. Use uppercase letters, numbers, and underscores, starting with a letter or underscore. This field contains the secret's name, not the key itself.
- `base_url` — optional API prefix. Use HTTPS without a username/password, query string, or fragment; include the version prefix when required, such as `/v1`. The bot appends the endpoint for the selected protocol. Do not append `/chat/completions`, `/responses`, `/messages`, or a model-specific endpoint yourself.
- `timeout_ms` — optional timeout for this entry, default `8000`, from `100` to `120000` milliseconds in queue mode, or `100` to `25000` in HTTP background mode. The remaining shared budget can shorten it.
- `json_mode` — optional boolean for `openai` and `openai_responses` only, default `false`. Set `true` when the site/model supports JSON-object mode. With `false`, the prompt still requests JSON and the result is parsed and validated.
- `max_tokens` — optional for `anthropic` only, default `8192`. Must be an integer from `1` to `65536` and supported by the selected model.

Unknown fields are rejected. Use numeric JSON values for `timeout_ms` and `max_tokens`, and `true`/`false` for `json_mode`, without quotes.

In the existing `[vars]` section of `wrangler.toml`, replace `TRANSLATION_PROVIDERS = ""` with this complete two-provider list. Replace the relay URL and model placeholder with the values supplied by your service. Set the **existing** `TRANSLATION_TIMEOUT_MS` key to `"60000"`; do not add duplicate keys or a second `[vars]` section.

```toml
TRANSLATION_PROVIDERS = '''
[
  {
    "name": "gemini-primary",
    "type": "gemini",
    "model": "gemini-3.5-flash-lite",
    "api_key_env": "GEMINI_API_KEY",
    "base_url": "https://generativelanguage.googleapis.com/v1beta",
    "timeout_ms": 30000
  },
  {
    "name": "relay-backup",
    "type": "openai",
    "model": "replace-with-relay-model-id",
    "api_key_env": "RELAY_API_KEY",
    "base_url": "https://relay.example/v1",
    "timeout_ms": 30000,
    "json_mode": false
  }
]
'''
TRANSLATION_TIMEOUT_MS = "60000"
```

For the relay entry, `https://relay.example/v1` produces a request to `https://relay.example/v1/chat/completions`. `"json_mode": false` is the compatibility default; the response must still contain valid translation JSON.

Save the relay key interactively and deploy the configuration:

```sh
npx wrangler secret put RELAY_API_KEY
npm run deploy
```

Paste the API key when Wrangler prompts for it, rather than putting it in the command or configuration. Configure `GEMINI_API_KEY` as in deployment step 5 if it is not already present. The relay is used after Gemini fails; to prefer it, move its entry first.

For more sites, models, or keys, copy an entry and give it a unique `name`. A shared site can appear several times with different `model` values or `api_key_env` secret names. The [full protocol template](translation-providers.example.json) includes all four supported protocol types. Remove unused entries; if keeping all five sample entries, change the existing total budget to `"90000"` for their combined timeouts. Queue mode accepts a total budget up to `"120000"`. The JSON file is a template: paste its array into `TRANSLATION_PROVIDERS`; the Worker does not load the file directly.

### Failover behavior

Each eligible event starts at the first entry. The first valid translation is used. Missing API-key secrets, non-success HTTP responses (including `401`, `403`, `402`, `429`, and server errors), network failures, timeouts, and invalid translation output trigger the next entry. A malformed provider configuration stops translation before any provider is called.

Each entry is attempted at most once per queue attempt, within the shared `TRANSLATION_TIMEOUT_MS` budget. The bot does not check an account's remaining balance in advance or persist a preferred provider between attempts. A slow entry can consume the remaining budget, so reaching every configured provider is not guaranteed. A retried job starts from the first entry again and fetches the source's current content.

### Queue processing and retries

The webhook waits for a successful queue write before returning `202 accepted`. A failed queue write returns `503`; the event has not been accepted and can be redelivered. Jobs contain compact repository, installation, and source identifiers, never source text, API keys, or installation tokens. Version 1 PR title/description jobs and version 2 PR discussion comment jobs remain supported. The expanded scope uses version 3 jobs with a source kind and, when applicable, a source ID.

The consumer obtains a fresh installation token, checks its approved comment write permission, and refetches the current PR or Issue. Comment and Review jobs fetch their source by ID and verify its association. It skips jobs for an unconfigured owner, closed PRs or Issues, and repositories that are now private when `ALLOW_PRIVATE` is disabled. Missing, empty, translator-generated, or pending Review sources are skipped. The recommended **Issues → Read and write** and **Pull requests → Read-only** settings cover the full scope. The comment API accepts either repository write permission; source access and event subscriptions still require the corresponding read permissions. The permission diagnostic logs permission names and levels, never the token.

Temporary failures such as `429`, `5xx`, network errors, and timeouts are retried after **30, 60, and 120 seconds**, for at most **four processing attempts**. Each attempt has its own translation budget. Invalid configuration, missing secrets, authentication/permission errors such as `401`/`403`, and exhausted attempts are sent to `pr-translator-dead-letter` and acknowledged only after that queue write succeeds. A failed dead-letter write leaves the original job available for retry.

The dead-letter queue has no automatic consumer: review logs, fix the underlying problem, and redeliver the original supported GitHub event to run it again. Inspect queued metadata in **Cloudflare dashboard → Queues → pr-translator-dead-letter → Messages → List**; see [listing messages](https://developers.cloudflare.com/queues/examples/list-messages-from-dash/). Free-plan messages expire after **24 hours**, including dead-letter jobs, so the queue is not a permanent archive. The queue holds repository and source identifiers even though it does not hold text or credentials.

### Optional HTTP background mode

To run without Cloudflare Queues, remove **all** `[[queues.producers]]` and `[[queues.consumers]]` blocks from `wrangler.toml`, set `TRANSLATION_TIMEOUT_MS = "20000"`, and redeploy. Also reduce each configured provider's `timeout_ms` to at most `25000`; the 30-second entries in the example above require queue mode. This mode uses `ctx.waitUntil()` and has no delayed automatic retries or dead-letter storage. Its translation budget must stay at or below `25000` ms because processing is limited to [30 seconds after the HTTP response](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil). `202 accepted` then means background processing was scheduled rather than persisted.

## Local development and tests

Run the local tests:

```sh
npm test
```

The tests cover webhook signatures, JWT signing, queue persistence and acknowledgement, bounded retries and dead-letter handling, installation permissions, and title/description translations for PRs and Issues. Comment and Review checks cover discussion comments, inline comments, Review bodies, other bot authors, source-specific updates, loop prevention, missing or changed sources, and source association. They also cover the private-repository filter, provider configuration, API request/response formats, and failover behavior. They use mocked API responses and require no real credentials. `npm run test:runtime` runs the dedicated Miniflare/workerd checks using the actual Worker runtime and intercepted outbound requests; these checks are also included in `npm test`. Verify deployment and translation quality with the manual steps above.

For local webhook processing, copy [.dev.vars.example](.dev.vars.example) to `.dev.vars`, fill in the GitHub credentials, and enable the API-key variables required by your provider list. The default single-Gemini setup requires `GEMINI_API_KEY`. Keep `.dev.vars` private; `.gitignore` excludes it while allowing the example template to be committed.

**Bash / Git Bash:**

```bash
cp .dev.vars.example .dev.vars
```

**Windows PowerShell:**

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Remote Worker secrets are not automatically available locally. The private key must still be PKCS#8; the code accepts actual line breaks or literal `\n` sequences. Then start the development server:

```sh
npm run dev
```

The server keeps running in that terminal; use another terminal for additional commands, or stop it with `Ctrl+C`.

## Costs and translation providers

Hosting limits and translation quotas are separate. Each translation attempt may be billed by the API provider, including attempts whose output cannot be used. Each eligible title/description event, comment creation or edit, or Review submission or edit creates a separate job. Enabling more event types increases calls; failover and retries can produce several calls for one source. Check each provider's current pricing and your account's quota before deployment.

- **Gemini — integrated.** The configured model is `gemini-3.5-flash-lite`. Free access and rate limits depend on the model, region, and account. See [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- **OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages — integrated.** Use your site's model IDs and API keys. See [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing); third-party sites set their own rates and quotas.
- **Cloudflare Workers — hosting.** The Free plan has request and CPU limits; check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- **Cloudflare Queues — job storage and delivery.** The Free plan includes 10,000 queue operations per day and retains messages for 24 hours. Writes, reads, deletes, and retry reads count as operations; a successfully processed small job typically uses three operations. Retries and dead-letter writes add operations. See [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
- **DeepL API and Google Cloud Translation — not integrated.** These need separate adapters; adding a URL to the provider list is insufficient. See [DeepL billing](https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API) and [Cloud Translation pricing](https://cloud.google.com/products/translate/pricing) if you plan to add support.

## Troubleshooting

Start with **Recent Deliveries** for the incoming webhook response and `npm run tail` for background processing errors.

- **No new webhook delivery after an edit**: first verify the correct translation App's **Webhook → Active**, saved event subscriptions, and installation access to the repository. An "edited" badge on GitHub does not confirm that this App received an event. Test with an actual text change and inspect the matching `edited` delivery. If there is no delivery, investigate GitHub's event configuration before changing the Worker or model timeout. See [viewing webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries).
- **`401 Invalid webhook signature`**: check that `GITHUB_WEBHOOK_SECRET` is configured on the correct Worker and matches GitHub exactly.
- **`404 Not found`**: GitHub must send a `POST` request to `/webhook`; the root URL is a health check.
- **`200 ignored owner`**: the repository owner's login does not match `TARGET_OWNER`.
- **`200 ignored private repository`**: private repositories are disabled. Set `ALLOW_PRIVATE = "true"` and redeploy only if you intend to translate their contents.
- **`200 ignored action` / `200 ignored`**: the action or event is outside the supported set. A signed `ping` returns `200 pong`.
- **Titles translate, but comments or Reviews do not**: deploy the current code and enable all five events in **Permissions & events → Subscribe to events**. Ordinary comments use `issue_comment` (`created`/`edited`), inline comments use `pull_request_review_comment` (`created`/`edited`), and Review bodies use `pull_request_review` (`submitted`/`edited`). Check `X-GitHub-Event` and the action in Recent Deliveries. Editing a title or description does not translate existing comments. Trigger or redeliver the event for the specific source on an open PR or Issue. Empty or pending Reviews are skipped; Review and inline comment translations appear in Conversation.
- **`400 Invalid JSON` or a missing-field response**: the signed payload is malformed or lacks required installation, repository, PR/Issue, comment, or Review fields; check the delivery payload, especially when testing manually.
- **`202 accepted`, but no comment**: inspect queue invocations in `npm run tail`. Temporary failures show a delayed retry; permanent or exhausted failures go to the dead-letter queue. Closed PRs and Issues are skipped. Check the GitHub secrets, App installation and permissions, provider configuration, model access, quota, and API-key secret names.
- **Webhook returns `503` when enqueueing**: verify that `pr-translator-jobs` exists, its producer binding is deployed, and the account's Queues limits have not been reached. After fixing it, redeliver the GitHub event.
- **`GITHUB_PRIVATE_KEY must be PKCS#8`**: convert the key and upload the complete `BEGIN PRIVATE KEY` PEM, rather than a filename.
- **GitHub API `401` / `403` in logs**: check the App ID, private key, installation access, and approved repository permissions.
- **Comment permissions are missing or a GitHub call returns `403`**: check the `GitHub installation permissions:` log. The recommended **Issues → Read and write** and **Pull requests → Read-only** or higher cover the full scope. Save App permission changes and have the installation account approve the update. Confirm that you edited the App matching `GITHUB_APP_ID` and that its installation includes the target repository, then redeliver the supported source event. The bot checks approved comment write permission and fetches source content before calling the translation model. Changing translation providers or redeploying the Worker does not grant missing GitHub permission.
- **Provider `404`**: check the model ID and `base_url`. Use the API prefix, not a complete endpoint; an OpenAI-compatible Chat Completions site must use `type: "openai"`.
- **Provider `402` / `429`**: check quota, billing, and rate limits. The bot tries the next configured entry if time remains. In queue mode, `429` can trigger a delayed retry if no provider succeeds; `402` alone is treated as a permanent billing problem.
- **Invalid response or JSON-mode error**: check that the site's response format matches the selected `type`. For an OpenAI-compatible site that does not support JSON-object mode, set `json_mode` to `false`; the returned translation must still be valid JSON with the required fields.
- **Timeout before the last provider**: reduce individual `timeout_ms` values, reorder the list, or adjust `TRANSLATION_TIMEOUT_MS` within its allowed range. The shared budget applies to all attempts together.
- **Gemini timeout with no provider list**: the single Gemini attempt uses the full shared budget (60 seconds by default in queue mode). Logs show the actual timeout, elapsed completion time, and whether a timeout happened before response headers or while reading the body. Queue mode retries temporary failures automatically. For an explicit provider list, each entry still defaults to 8 seconds unless `timeout_ms` is set. Persistent upstream failures still require a working service or backup.

## Security and limitations

- **Credentials:** webhook signatures are verified using HMAC-SHA256 over the raw request body. GitHub calls use short-lived installation tokens obtained with an RS256 App JWT; no personal access token is needed. Never commit API keys or private keys. `.gitignore` excludes `.dev.vars*`, `.env*`, `*.pem`, and `*.key`.
- **Private content:** PR/Issue titles and descriptions, discussion comments, inline review comments, and Review bodies can be sent to any provider reached in the configured list, including third-party API sites. Private repositories are disabled by default. Enable them only when you trust every listed provider with that content and have reviewed its data-use terms, including [Gemini's terms](https://ai.google.dev/gemini-api/terms) when applicable.
- **Translation fidelity:** the prompt asks the model to preserve Markdown, links, code, HTML tags and attributes, timestamps, identifiers, paths, URLs, issue numbers, and mentions. JSON output is parsed and checked for required fields, but formatting preservation and mixed-language handling depend on the model's output.
- **Text length:** only the first **12,000 UTF-16 code units** of each description, source comment, or Review body are translated. A note is added to the translation when its source is truncated.
- **Comment lookup:** the bot searches up to the first **500 discussion comments** for a bot-authored translation marker. PR title/description translations retain `<!-- pr-translator-bot:v1 -->`; each other source uses its own marker. If no match is found, it creates a translation comment.
- **Scope and deletion:** sources must belong to open PRs or Issues. Review and inline comment translations are posted in PR Conversation. Translator-generated content is skipped to prevent loops; comments from other bots remain eligible. Deleting a source does not delete an already published translation, and history is not translated automatically. Code diffs, commit comments, and GitHub Discussions are not translated.
- **Delivery and concurrency:** Queues delivers messages at least once. The supplied consumer uses a batch size and maximum concurrency of one to reduce comment races, but the bot has no persistent lock or global idempotency state. Duplicate delivery and concurrent deployments can still cause duplicate comments. Each eligible attempt still requests a translation, even when the generated comment is unchanged. See [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
- **Processing deadline and retries:** queue mode supports a 60-second default translation budget and bounded delayed retries, up to a 120-second translation budget per attempt. Retries can call the model again and incur additional provider charges. Queues cannot make an unavailable API succeed, and pending/dead-letter messages expire according to the account's retention limit. HTTP background mode keeps its shorter deadline and does not retry automatically.

## Publishing to GitHub

Commit the source, tests, `package.json`, `package-lock.json`, documentation, `LICENSE`, `.gitignore`, and the placeholder templates: `wrangler.example.toml`, `.dev.vars.example`, and `translation-providers.example.json`. Keep example URLs, account names, model placeholders, and secrets generic so others can configure their own deployment.

Keep actual `wrangler.toml`, `.dev.vars`, `.env` files, private keys (`.pem`/`.key`), `.wrangler/`, `node_modules/`, and generated release archives out of Git. These are excluded by `.gitignore`; review `git status --short` and `git diff --cached` before committing. Publish the reviewed source tree to your GitHub repository. A fresh clone starts by copying `wrangler.example.toml` as described in deployment step 1.

### Automatic tests and Releases

The repository includes two GitHub Actions workflows:

- [CI](.github/workflows/ci.yml) runs `npm ci` and `npm test` on Node.js 22 and 24 for pushes to `main` and pull requests. Tests use simulated APIs, including intercepted requests in the Worker runtime; they do not require real model credentials.
- [Release](.github/workflows/release.yml) runs when you push a tag beginning with `v`. It first runs the same CI checks, verifies that the tag equals `v` plus the version in `package.json` and that `package-lock.json` has matching project versions, then creates a GitHub Release with generated release notes. A failed check stops publication.

The Release is created on GitHub using the workflow's automatic `GITHUB_TOKEN`. No Cloudflare credentials or model API keys belong in GitHub Actions secrets for these workflows. GitHub provides **Source code ZIP** and **TAR.GZ** downloads for the tag. The workflows do not create a local `release/` directory or deploy a Worker; each user follows [the quick start](#quick-start-and-everyday-use) to deploy their own instance.

Versions containing `-`, such as `v1.1.0-rc.1`, are marked as prereleases. Rerunning a published tag skips duplicate creation. If a draft already exists for that tag, publish or delete the draft before rerunning.

For the first `1.0.0` release, commit and push the prepared source to `main`, then create and push the matching tag:

```sh
git push -u origin main
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

This example assumes your reviewed changes have already been committed and `origin` points to your GitHub repository. After pushing the tag, inspect **Actions → Release** for the result, then open **Releases** to see the published version.

For a later patch release, update the npm version and lock file, commit the change, and tag that commit. For example, when the current version is `1.0.0`:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release v1.0.1"
git push origin main
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

Commit any other release changes before tagging. Use the resulting version in both tag commands; `v1.0.1` here is an example. If release creation is denied by repository or organization policy, check **Settings → Actions** permissions and the Release job's logs.

## Project structure

```text
pr-translator-bot/
├── README.md                 # English documentation
├── README.zh-CN.md           # Simplified Chinese documentation
├── LICENSE                   # MIT license
├── .dev.vars.example         # Local secret template with placeholder values
├── translation-providers.example.json # Ordered provider configuration template
├── .gitignore                # Excludes local secrets and private keys
├── .github/workflows/
│   ├── ci.yml                # Tests on pushes and pull requests
│   └── release.yml           # Tests and publishes v* tags
├── package.json              # npm scripts and Wrangler dependency
├── package-lock.json         # Reproducible dependency versions
├── wrangler.example.toml     # Public Worker configuration template
├── wrangler.toml             # Local deployment configuration; ignored by Git
├── src/
│   ├── index.js              # Webhook/queue handlers, authentication, comments
│   ├── github.js             # GitHub authentication, requests, translation lookup
│   ├── content.js            # Issue, comment, and Review translation jobs
│   └── translation.js        # Provider adapters, validation, ordered failover
└── test/
    ├── webhook.test.js       # Signature verification and JWT signing
    ├── integration.test.js   # Mocked comment flow and private-repository filter
    ├── comment.test.js       # PR Conversation events, source validation, updates
    ├── content.test.js       # Issue, discussion, inline comment, and Review coverage
    ├── queue.test.js         # Persistence, permissions, retries, dead letters
    ├── runtime.test.js       # Actual Worker runtime with intercepted API requests
    ├── runtime-queue.test.js # Native queue processing in the Worker runtime
    └── translation.test.js   # Provider configuration, protocol formats, failover
```

## License

This project is licensed under the [MIT License](LICENSE). You may use, modify, distribute, and use the software commercially, provided you retain the copyright and permission notices in all copies or substantial portions of the software. The software is provided as is, without warranty.
