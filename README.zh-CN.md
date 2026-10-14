# PR Translator Bot

[English](README.md) · **简体中文**

自动将 GitHub PR 与 Issue 的标题、正文、讨论评论，以及 PR 行内审查评论和 Review 正文在中文与英文之间互译。译文作为独立评论发布到对应 PR 或 Issue 的讨论区。

机器人以 **GitHub App** 的形式运行在 **Cloudflare Workers** 上，通过 Cloudflare Queues 处理后台任务与有限次数的重试。支持 Gemini、OpenAI 兼容接口、OpenAI Responses 和 Anthropic。可按优先级配置多个站点与模型；某个接口失败或配额耗尽时，自动尝试下一项。安装一次 App，即可覆盖你选择的仓库，无需为每个仓库配置 GitHub Actions 工作流。

## 目录

- [快速入门与日常使用](#快速入门与日常使用)
- [功能与行为](#功能与行为)
- [部署](#部署)
- [配置说明](#配置说明)
- [本地开发与测试](#本地开发与测试)
- [费用与翻译服务](#费用与翻译服务)
- [常见问题](#常见问题)
- [安全与限制](#安全与限制)
- [发布到 GitHub](#发布到-github)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 快速入门与日常使用

你需要部署自己的 Worker 并注册 GitHub App。可以下载某个 Release 的源码包，或将 `<repository-url>` 替换为本仓库的克隆地址后运行：

```sh
git clone <repository-url> pr-translator-bot
cd pr-translator-bot
npm ci
```

使用源码包时，先解压，在包含 `package.json` 的目录中打开终端，再运行 `npm ci`。

首次使用按以下顺序配置：

1. **创建本地配置。** PowerShell 运行 `Copy-Item wrangler.example.toml wrangler.toml`；Bash 运行 `cp wrangler.example.toml wrangler.toml`。将 `TARGET_OWNER` 改为目标仓库所属的 GitHub 用户或组织。使用中转站或多个 API 时，按[多站点与模型配置](#多站点与模型配置)填写地址、模型、协议和 API Key 的 Secret 名称。默认配置使用 Gemini；除非准备翻译私有内容，否则保留 `ALLOW_PRIVATE = "false"`。
2. **部署 Worker 与队列。** 运行以下命令，并保存 Wrangler 输出的 Worker 地址：

   ```sh
   npx wrangler login
   npx wrangler queues create pr-translator-jobs
   npx wrangler queues create pr-translator-dead-letter
   npm run deploy
   ```

   已有部署只创建尚不存在的队列；修改队列名称时参考[部署第 2 步](#2-创建队列并部署-worker)。
3. **注册 GitHub App。** 开启 Webhook，填写 `<WORKER_URL>/webhook` 并生成 Webhook secret。仓库权限设为 **Issues → Read and write**、**Pull requests → Read-only**。订阅全部五项事件：**Pull request**、**Issues**、**Issue comment**、**Pull request review**、**Pull request review comment**。记录 App ID 并下载私钥；表单说明及已有安装的权限更新见[部署第 3 步](#3-注册-github-app)。
4. **将凭据保存到 Cloudflare。** 为 Worker 添加 `GITHUB_APP_ID`、`GITHUB_WEBHOOK_SECRET` 和 `GITHUB_PRIVATE_KEY` 三项 Secret。私钥必须为完整的 PKCS#8 PEM，按[私钥准备](#4-准备私钥)转换，再使用[部署第 5 步](#5-配置-worker-secrets)中对应终端的命令上传。默认配置还需要 `GEMINI_API_KEY`；使用服务列表时，逐项添加 `api_key_env` 指定的 Secret。Wrangler 提示时再输入密钥，不要写入配置或命令历史。例如：

   ```sh
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GEMINI_API_KEY
   ```

5. **安装 App。** 打开 App 的 **Install App**，选择 `TARGET_OWNER` 所属的目标仓库。创建一个含中文或英文内容的 PR 或 Issue，检查是否收到独立译文评论；其他内容类型的验证见[部署第 7 步](#7-验证翻译)。

配置完成后，正常使用 GitHub 即可。创建或编辑**打开的 PR／Issue**会翻译标题和正文；新建或编辑讨论评论会创建或更新该来源的译文。提交或编辑 Review 正文，以及新建或编辑 PR 行内审查评论，也会在 PR 的 **Conversation** 中收到译文。原文保持不变。已有历史不会自动补翻，需要编辑旧原文以触发它自己的翻译。

部署后的机器人在 Cloudflare 上运行，无需一直开着本地终端。`npm run tail` 仅用于查看日志，按 `Ctrl+C` 会停止日志查看。修改源码或 `wrangler.toml` 后，运行 `npm run deploy` 应用更新；发布 GitHub Release 不会部署你的 Worker。

## 功能与行为

- 翻译 **PR 与 Issue 的标题和正文**，保留原始文本。
- 翻译新建或编辑的**讨论评论**、**PR 行内审查评论**，以及**已提交或编辑的 Review 正文**，包括其他机器人发布的内容。每个来源都有独立的译文评论，并附原文链接；编辑原文时更新对应译文。
- 由翻译模型判断主要语言：以中文为主时翻译成英文，其他情况翻译成简体中文。
- 支持多个 API 站点、模型和 API Key，在每次翻译中按配置顺序自动切换。
- 处理 `pull_request` 事件的 `opened`、`edited`、`reopened`、`ready_for_review` 动作。草稿 PR 也会处理；仅推送提交（`synchronize`）不会触发翻译。
- 处理 `issues` 的 `opened`、`edited`、`reopened`；`issue_comment` 与 `pull_request_review_comment` 的 `created`、`edited`；以及 `pull_request_review` 的 `submitted`、`edited`。空白或尚未提交的 Review 正文会被跳过。
- 翻译前从 GitHub 获取 PR／Issue 与对应来源的当前内容，仅处理打开的 PR 和 Issue。通过本机器人的作者身份与译文标记防止循环，即使译文被人工编辑过。
- 先将任务保存到队列，临时失败时延迟重试；调用翻译 API 前检查安装的实际评论写权限。
- 每个 PR／Issue 的标题与正文使用一个带标记的译文评论，每条原评论或 Review 则使用各自独立的译文评论；仅在生成内容发生变化时更新。并发事件仍可能产生重复评论，详见[限制说明](#安全与限制)。
- 只处理配置的仓库所有者，默认跳过私有仓库。

例如，标题为“修复 Markdown 分页问题”的 PR，可能收到如下评论：

> ### Automatic translation · 中文 → English
>
> **Fix Markdown pagination issues**
>
> Fixed an issue where nested list items appeared too early during manual pagination.
>
> *Generated automatically by PR Translator Bot. Original PR text remains unchanged.*

代码差异本身、提交评论和 GitHub Discussions 不在支持范围内。

### 评论与 Review

启用对应 Webhook 事件后，在打开的 PR／Issue 上新建或编辑讨论评论、行内审查评论，或提交、编辑 Review 正文，会触发翻译。其他 GitHub App 发布的内容也会处理。每份译文作为独立的普通讨论评论发布，并附原文链接；行内评论与 Review 的译文统一出现在 PR 的 **Conversation** 中，方便集中查看。原文和审查状态保持不变。编辑原文时更新其自己的译文，不会覆盖其他来源的译文。

已有历史不会自动补翻。需要翻译旧内容时，在启用事件后编辑该原文，或重新投递对应来源的受支持事件。`pull_request`／`issues` 事件翻译标题与正文；讨论评论需要 `issue_comment`，行内评论需要 `pull_request_review_comment`，Review 正文需要 `pull_request_review`。

消费者会核验来源属于目标 PR／Issue，跳过缺失或空白的来源，并在发布前再次检查。翻译期间原文发生变化时，队列重试会使用最新内容。删除原文不会自动删除已经发布的译文评论。

```text
GitHub PR／Issue／评论／Review 事件 → 验证 Webhook 签名 → 保存精简队列任务 → 202 accepted
队列消费者 → 检查安装权限 → 读取 PR／Issue 与对应来源的当前内容
→ 按顺序尝试翻译服务 → 创建或更新译文评论
临时失败 → 有限次数的延迟重试；永久失败／重试耗尽 → 死信队列
```

## 部署

### 准备条件

- Node.js 和 npm。使用当前受支持的 Node.js LTS 版本，例如 Node.js 22 或 24；具体要求见 [Wrangler 系统要求](https://developers.cloudflare.com/workers/wrangler/install-and-update/)。
- 已启用 Workers 的 Cloudflare 账号。
- 有权限注册和安装 GitHub App 的 GitHub 账号。
- 至少一个有模型访问权限和可用配额的 API Key：Gemini、OpenAI 兼容服务、OpenAI Responses 或 Anthropic。默认的单服务配置使用 [Google AI Studio](https://aistudio.google.com/app/apikey) 创建的 Gemini API Key；请检查[支持的地区](https://ai.google.dev/gemini-api/docs/available-regions)。
- 终端中可用的 OpenSSL，用于转换私钥格式。Windows 默认不自带 OpenSSL。

### 1. 准备项目

在项目目录中打开终端，确认当前目录包含 `package.json`：

```sh
npm ci
```

将公开的配置模板复制为本地 `wrangler.toml`：

**Bash / Git Bash：**

```bash
cp wrangler.example.toml wrangler.toml
```

**Windows PowerShell：**

```powershell
Copy-Item wrangler.example.toml wrangler.toml
```

参考 [wrangler.example.toml](wrangler.example.toml)，修改本地副本。**必填：** 将 `TARGET_OWNER = "your-github-owner"` 替换为目标仓库所属的 GitHub 用户或组织名称；可修改 `name` 来设置其他 Worker 名称。模板包含队列绑定、60 秒翻译预算和三次延迟重试。除非准备将私有仓库中受支持的内容发送给配置的服务，否则保持私有仓库处理关闭。实际 `wrangler.toml` 已被 Git 忽略，公开仓库只提交占位值模板。需要多个 API 时，按[多站点与模型配置](#多站点与模型配置)设置。

### 2. 创建队列并部署 Worker

```sh
npx wrangler login
npx wrangler queues create pr-translator-jobs
npx wrangler queues create pr-translator-dead-letter
npm run deploy
```

首次部署前先创建两个队列。提供的 `wrangler.toml` 将任务生产者、消费者和死信生产者连接到同一个 Worker，不需要再部署第二个 Worker。修改队列名称时，需要同步修改所有对应的生产者、消费者与死信队列配置。已有部署只需创建尚不存在的队列。

记录 Wrangler 输出的访问地址，例如：

```text
https://pr-translator-bot.<your-subdomain>.workers.dev
```

打开根地址，应返回 `PR Translator Bot is running`。这只说明 Worker 可以访问，并不验证凭据或翻译服务是否可用。

Webhook 地址为 `<WORKER_URL>/webhook`。

### 3. 注册 GitHub App

使用 Node.js 生成 Webhook Secret；下面的命令适用于 Bash 和 PowerShell：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

妥善保存生成的值，随后需要在 GitHub 和 Cloudflare 中填写同一个值。

打开 [GitHub App 设置](https://github.com/settings/apps) → **New GitHub App**。如果目标仓库属于组织，请在该组织的设置中注册 App。

按以下内容配置：

- **GitHub App name**：选择唯一名称，例如 `PR Translator - <unique-suffix>`。
- **Homepage URL**：填写 Worker 根地址，或公开的项目仓库地址。
- **Webhook**：勾选 **Active**；将 **Webhook URL** 设为 `<WORKER_URL>/webhook`，**Webhook secret** 设为刚才生成的值。
- **Repository permissions**：设置 **Pull requests → Read-only**、**Issues → Read and write**，以及自动授予的 **Metadata → Read-only**。
- **Subscribe to events**：勾选 **Pull request**、**Issues**、**Issue comment**、**Pull request review**、**Pull request review comment**。
- **Where can this GitHub App be installed?**：选择 **Only on this account**，将安装范围限制在注册 App 的账号内。

**Issue comment** 同时负责 PR 和 Issue 的普通讨论评论；**Pull request review comment** 负责 PR 行内审查评论，不能代替前者。

**Issues → Read and write** 用于读取 Issue，以及通过 [Issue Comments API](https://docs.github.com/en/rest/issues/comments) 创建和更新普通讨论评论；**Pull requests → Read-only** 用于读取 PR、Review 与行内评论。这项配置也符合[各类 Webhook 的权限要求](https://docs.github.com/en/webhooks/webhook-events-and-payloads)。发布 PR 讨论评论也接受 **Pull requests → Read and write**，但完整 Issue 支持仍需要 Issues 权限。行内评论的译文发布为普通 PR 讨论评论，因此本功能不要求 Pull requests 写权限。

升级已有 App 时，部署本版本，再进入 **Permissions & events → Subscribe to events**，勾选全部五项事件并保存，保留已经勾选的项目。已有安装具有 **Issues → Read and write** 及 **Pull requests → Read-only** 或 **Read and write** 时，扩展范围不需要增加权限，现有 Worker Secrets 也可以继续使用。

如果 App 已安装，之后修改权限还需要由安装账号[批准新权限](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app)。打开安装账号的 **Settings → Applications → Installed GitHub Apps → Configure**，接受权限更新，或通过 GitHub 的通知邮件完成批准。仅保存 App 注册设置不会更新已有安装的权限。批准后，重新投递一个支持的事件即可；机器人每次任务都会获取新的安装令牌，授予权限本身不需要再次部署 Worker。

创建后记录 **App ID**，点击 **Generate a private key** 下载 `.pem` 私钥。这里需要的是 App ID，不是 Client ID 或安装 ID。无需启用 OAuth／用户授权。

在第 5 步配置 Worker Secrets 之前，GitHub 首次发送的 Webhook ping 可能失败。

### 4. 准备私钥

Worker 需要以 `-----BEGIN PRIVATE KEY-----` 开头的 PKCS#8 PEM 私钥。如果下载的私钥以 `-----BEGIN RSA PRIVATE KEY-----` 开头，执行转换：

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in github-app-downloaded.pem -out github-app-pkcs8.pem
```

将输入文件名替换为实际下载的 PEM 文件名。这是一行命令，Bash 和 PowerShell 都可使用。如果私钥已经是 PKCS#8 格式，下一步直接使用该文件即可。

### 5. 配置 Worker Secrets

在项目目录依次执行以下命令，并按提示输入对应的值：

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

- `GITHUB_APP_ID`：第 3 步记录的 App ID。
- `GITHUB_WEBHOOK_SECRET`：与 GitHub App 设置中完全相同的值。

从 PKCS#8 文件导入 `GITHUB_PRIVATE_KEY` 的完整内容，包括 PEM 头尾和换行。

**Bash / Git Bash：**

```bash
npx wrangler secret put GITHUB_PRIVATE_KEY < github-app-pkcs8.pem
```

**Windows PowerShell：**

```powershell
Get-Content -Raw .\github-app-pkcs8.pem | npx wrangler secret put GITHUB_PRIVATE_KEY
```

PowerShell 不支持 Bash 的 `< 文件` 输入重定向。Wrangler [支持通过管道传入 Secret](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put)，请使用对应终端的命令。`wrangler secret put` 会将更新后的 Secrets 部署到配置文件指定的 Worker。

默认的单 Gemini 配置还需要添加它的 API Key：

```sh
npx wrangler secret put GEMINI_API_KEY
```

使用多个服务时，按实际列表中每项的 `api_key_env` 添加对应的 Secret。下面的[中转配置](#多站点与模型配置)使用 `GEMINI_API_KEY` 与 `RELAY_API_KEY`。API Key 应保存在 Worker Secrets 中，不要写进服务列表 JSON 或 `wrangler.toml`。

### 6. 安装 App

在 GitHub App 设置中打开 **Install App**，选择目标账号，然后选择 **All repositories**（全部仓库）或 **Only select repositories**（指定仓库）。

仓库必须属于 `TARGET_OWNER`。安装到个人账号不会覆盖其他组织拥有的仓库，详见 [GitHub App 安装说明](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)。

### 7. 验证翻译

1. 运行 `npm run tail`，观察 Worker 日志。
2. 在已安装 App 的公开仓库中创建一个中文标题和描述的 PR，检查是否收到英文译文评论。
3. 修改 PR 描述；译文发生变化时，检查原评论是否被更新。
4. 再创建一个以英文为主的 PR，检查是否收到简体中文译文。
5. 在打开的 PR 中新建一条英文 Conversation 评论，可包含 Markdown 链接或 HTML 标签，检查是否出现附原评论链接的独立中文译文。编辑原评论，确认对应的已有译文被更新。
6. 创建 Issue，编辑标题或正文，再新建或编辑讨论评论。确认 Issue 的标题／正文与每条评论都有各自独立的译文。
7. 提交一份正文非空的 PR Review，并新建一条行内审查评论。确认两者分别在 PR Conversation 中产生附原文链接的译文。编辑各自的原文，检查对应译文是否更新。正文为空的批准 Review 没有需要翻译的文本。

在 GitHub App 设置 → **Advanced → Recent Deliveries** 中查看 Webhook 响应。**`202 accepted` 表示任务已保存到队列，不代表翻译成功。** 在 `npm run tail` 中，队列处理会显示为独立的一次执行。修复永久性的配置或权限问题后，可以对相关事件点击 **Redeliver**，或编辑需要翻译的原文。`npm run tail` 只负责查看日志；按 `Ctrl+C` 停止它不会停止线上机器人。

## 配置说明

非敏感配置保存在本地 `wrangler.toml`，由 [wrangler.example.toml](wrangler.example.toml) 复制生成：

- `TARGET_OWNER`：**必填**。将模板中的 `"your-github-owner"` 替换为 GitHub 用户或组织名称，只处理该账号拥有的仓库；名称匹配不区分大小写。配置缺失或为空时会跳过仓库事件。
- `GEMINI_MODEL`，默认 `"gemini-3.5-flash-lite"`：默认单服务配置使用的 Gemini 模型 ID。应选择你的 API Key 可以访问、且支持结构化 JSON 输出的模型。配置服务列表后，不再使用此变量。
- `ALLOW_PRIVATE`，默认 `"false"`：只有设为精确字符串 `"true"` 时才处理私有仓库。
- `TRANSLATION_PROVIDERS`，默认 `""`：按优先级排列的翻译服务 JSON 数组。缺失或留空时使用原来的 `GEMINI_MODEL` + `GEMINI_API_KEY` 配置，单次 Gemini 尝试可使用完整的 `TRANSLATION_TIMEOUT_MS` 总预算；显式空数组（`[]`）属于配置错误。
- `TRANSLATION_TIMEOUT_MS`：所有翻译尝试共用的时间预算，单位毫秒。提供的队列配置为 `"60000"`；队列处理允许 `1000`–`120000`，未设置时默认 `60000`。GitHub 认证、读取原文和写入译文不计入该预算。可选的 HTTP 后台模式默认 `20000`，仅允许 `1000`–`25000`。

修改这些配置后，运行 `npm run deploy`。每个 Worker 部署只支持一个仓库所有者。三项 GitHub 凭据及所有服务的 API Key 应保存在 Worker Secrets 中，不要写入 `wrangler.toml`。

### 多站点与模型配置

每一项指定接口协议、站点、模型和 API Key 对应的 Secret。为 Gemini 添加 OpenAI 兼容中转备用服务时，先从中转站文档或控制台取得 **API 前缀地址**、**准确的模型 ID** 和 **API Key**。模型显示名称可能与接口接受的 ID 不同。

支持的协议类型：

- `gemini`：Gemini `generateContent`；默认 `base_url` 为 `https://generativelanguage.googleapis.com/v1beta`。
- `openai`：OpenAI 兼容的 Chat Completions；默认 `base_url` 为 `https://api.openai.com/v1`。
- `openai_responses`：OpenAI Responses；默认 `base_url` 为 `https://api.openai.com/v1`。
- `anthropic`：Anthropic Messages；默认 `base_url` 为 `https://api.anthropic.com/v1`。

`type` 按**接口协议**选择，而不是模型品牌。例如，中转站通过 OpenAI 兼容 Chat Completions 提供 Gemini 或 Claude 模型时，仍填写 `openai`。“OpenAI 兼容”指站点接受 Chat Completions 请求，并返回对应格式的响应。只支持 Responses 的站点应使用 `openai_responses`。DeepL、Google Cloud Translation 等其他协议仍需在 [src/translation.js](src/translation.js) 中增加适配器。

每项支持以下字段：

- `name`：必填，日志中显示的唯一名称，长度为 1–64 个字符。可使用中文、英文字母、数字、空格、`_`、`.` 和 `-`。
- `type`：必填，取上面的四种协议类型之一。
- `model`：必填，该站点提供的模型 ID。
- `api_key_env`：必填，保存此项 API Key 的 Worker Secret 名称，例如 `RELAY_API_KEY`。只使用大写字母、数字和下划线，以字母或下划线开头；这里填写 Secret 名称，不是 API Key 本身。
- `base_url`：可选，API 前缀地址。必须使用 HTTPS，且不能含用户名／密码、查询参数或片段；按站点要求包含版本前缀，例如 `/v1`。机器人会根据协议自动追加接口路径，不要自行追加 `/chat/completions`、`/responses`、`/messages` 或具体模型的路径。
- `timeout_ms`：可选，当前项的超时，默认 `8000`。队列模式允许 `100`–`120000` 毫秒，HTTP 后台模式允许 `100`–`25000` 毫秒。实际值还会受剩余总预算限制。
- `json_mode`：仅 `openai` 和 `openai_responses` 支持的可选布尔值，默认 `false`。站点／模型支持 JSON-object 模式时可设为 `true`；设为 `false` 时仍通过提示词要求 JSON，并解析、校验返回结果。
- `max_tokens`：仅 `anthropic` 支持的可选字段，默认 `8192`。必须是 `1`–`65536` 的整数，并且在所选模型的支持范围内。

不支持的额外字段会被拒绝。JSON 中 `timeout_ms`、`max_tokens` 使用数字，`json_mode` 使用 `true`／`false`，不要加引号。

在 `wrangler.toml` 已有的 `[vars]` 中，将 `TRANSLATION_PROVIDERS = ""` 替换为下面完整的双服务列表。用中转站提供的值替换地址与模型占位值，将**已有的** `TRANSLATION_TIMEOUT_MS` 改为 `"60000"`；不要添加重复的键或第二个 `[vars]`。

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

上面的中转配置会将 `https://relay.example/v1` 拼接为 `https://relay.example/v1/chat/completions`。`"json_mode": false` 是兼容性默认值，返回内容仍须包含有效的翻译 JSON。

通过交互方式保存中转 Key，然后部署配置：

```sh
npx wrangler secret put RELAY_API_KEY
npm run deploy
```

Wrangler 提示时再粘贴 API Key，不要将其写进命令或配置文件。尚未配置 `GEMINI_API_KEY` 时，按部署第 5 步添加。中转服务会在 Gemini 失败后使用；需要优先使用中转时，将它移到列表第一项。

增加更多站点、模型或 Key 时，复制一项并设置唯一的 `name`。同一站点可重复出现，分别填写不同的 `model` 或 `api_key_env` Secret 名称。[全协议模板](translation-providers.example.json)包含四种已支持协议；通常删掉不用的项目。保留全部五项示例时，可将已有总预算改为 `"90000"`，匹配各项超时之和；队列模式总预算最多为 `"120000"`。JSON 文件只是模板，需要将其数组粘贴到 `TRANSLATION_PROVIDERS`；Worker 不会直接读取该文件。

### 自动切换行为

每个符合条件的事件都从列表第一项开始，取得有效译文后结束尝试。API Key Secret 缺失、非成功 HTTP 响应（包括 `401`、`403`、`402`、`429` 和服务端错误）、网络失败、超时，以及译文结果无效时，会尝试下一项。服务列表格式或字段不合法时，在调用任何服务之前终止翻译。

每项在同一次队列执行中最多尝试一次，且共享 `TRANSLATION_TIMEOUT_MS` 总预算。机器人不会提前查询账号余额，也不会跨执行记住优先服务。慢接口可能消耗剩余时间，因此不保证访问到列表中的每个服务。重试任务会重新获取原文的当前内容，并从列表第一项重新开始。

### 队列处理与重试

Webhook 等待队列写入成功后才返回 `202 accepted`。写入失败时返回 `503`，表示没有接受该任务，可以重新投递。任务只保存精简的仓库、安装与来源标识，不包含原文、API Key 或安装令牌。升级后仍支持版本 1 的 PR 标题／正文任务，以及版本 2 的 PR 讨论评论任务；扩展范围使用版本 3 任务，包含来源类型及需要时的来源 ID。

消费者获取新的安装令牌，检查已批准的评论写权限，再读取 PR／Issue 当前状态。评论与 Review 任务还会按 ID 读取来源并核验归属。非目标所有者的任务、已关闭的 PR／Issue，以及默认设置下已变为私有的仓库都会跳过；缺失、空白、由本机器人生成的来源及未提交的 Review 也会跳过。推荐的 **Issues → Read and write** 与 **Pull requests → Read-only** 配置覆盖完整范围。评论接口接受两种仓库写权限之一，但读取原文和订阅事件仍需要对应的读权限。权限诊断日志只输出权限名称与等级，不输出令牌。

`429`、`5xx`、网络错误和超时等临时失败，会分别在 **30、60、120 秒**后重试，最多执行 **四次**。每次执行有独立的翻译预算。配置无效、Secret 缺失、`401`／`403` 等认证或权限错误，以及重试次数耗尽的任务，会写入 `pr-translator-dead-letter`，写入成功后才确认原任务。死信写入失败时，保留原任务供重试。

死信队列没有自动消费者：先查看日志并修复原因，再从 GitHub 重新投递原来的、受支持的事件。在 **Cloudflare 控制台 → Queues → pr-translator-dead-letter → Messages → List** 查看队列中的标识信息，详见[查看消息](https://developers.cloudflare.com/queues/examples/list-messages-from-dash/)。免费计划的消息（包括死信）在 **24 小时**后过期，不能作为永久存档。虽然队列不保存正文或凭据，仍会保存仓库与原评论标识。

### 可选的 HTTP 后台模式

不使用 Cloudflare Queues 时，从 `wrangler.toml` 删除**全部** `[[queues.producers]]` 与 `[[queues.consumers]]` 配置块，将 `TRANSLATION_TIMEOUT_MS` 改为 `"20000"`，再重新部署。同时将每项服务的 `timeout_ms` 调至最多 `25000`；上面的 30 秒服务示例需要队列模式。此模式使用 `ctx.waitUntil()`，没有延迟自动重试或死信存储。由于 HTTP 响应后最多继续执行 [30 秒](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)，翻译预算不能超过 `25000` 毫秒。此时 `202 accepted` 表示已安排后台处理，而非任务已持久保存。

## 本地开发与测试

运行本地测试：

```sh
npm test
```

测试覆盖 Webhook 签名、JWT 签名、队列持久保存与确认、有限重试与死信处理、安装权限，以及 PR／Issue 的标题与正文翻译。评论与 Review 检查覆盖讨论评论、行内评论、Review 正文、其他机器人作者、按来源更新、防止循环、来源缺失或变化及归属校验；还覆盖私有仓库过滤、服务配置、各类接口的请求／响应格式和自动切换行为。测试使用模拟 API 响应，不需要真实凭据。`npm run test:runtime` 单独运行 Miniflare/workerd 检查，使用真正的 Worker 运行时并拦截出站请求；这些检查也包含在 `npm test` 中。实际部署与翻译质量需按上面的手动步骤验证。

在本地处理 Webhook 时，将 [.dev.vars.example](.dev.vars.example) 复制为 `.dev.vars`，填写 GitHub 凭据，并启用服务列表需要的 API Key 变量。默认单 Gemini 配置需要 `GEMINI_API_KEY`。不要公开 `.dev.vars`；`.gitignore` 会忽略该文件，同时允许提交示例模板。

**Bash / Git Bash：**

```bash
cp .dev.vars.example .dev.vars
```

**Windows PowerShell：**

```powershell
Copy-Item .dev.vars.example .dev.vars
```

远端 Worker Secrets 不会自动用于本地开发。私钥仍需使用 PKCS#8 格式；代码支持实际换行或字面量 `\n` 序列。然后启动开发服务器：

```sh
npm run dev
```

开发服务器会持续占用该终端；其他命令请在另一个终端执行，或先按 `Ctrl+C` 停止服务器。

## 费用与翻译服务

托管限制与翻译配额独立计算。每次翻译尝试都可能由 API 服务商计费，包括最终结果无法使用的尝试。每个符合条件的标题／正文事件、评论新建或编辑、Review 提交或编辑都会产生独立任务。启用更多事件会增加调用；自动切换与重试可能让同一个来源产生多次调用。部署前请确认各服务的当前价格和账号实际配额。

- **Gemini：已集成。** 当前配置模型为 `gemini-3.5-flash-lite`。免费访问与速率限制取决于模型、地区和账号，详见 [Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing)及[速率限制](https://ai.google.dev/gemini-api/docs/rate-limits)。
- **OpenAI 兼容 Chat Completions、OpenAI Responses 和 Anthropic Messages：已集成。** 使用对应站点的模型 ID 和 API Key；详见 [OpenAI 价格](https://developers.openai.com/api/docs/pricing)和 [Anthropic 价格](https://platform.claude.com/docs/en/about-claude/pricing)。第三方站点自行规定价格和配额。
- **Cloudflare Workers：托管服务。** 免费计划有请求量与 CPU 使用限制，详见 [Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)。
- **Cloudflare Queues：任务存储与投递。** 免费计划每天包含 10,000 次队列操作，消息保留 24 小时。写入、读取、删除与重试读取都计入操作次数；成功处理一个小任务通常需要三次操作，重试和死信写入会增加操作次数。详见 [Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/)。
- **DeepL API 和 Google Cloud Translation：尚未集成。** 需要增加独立适配器，不能仅在列表中添加 URL。准备扩展时，可参考 [DeepL 计费说明](https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API)和 [Cloud Translation 价格](https://cloud.google.com/products/translate/pricing)。

## 常见问题

先在 **Recent Deliveries** 中查看收到的 Webhook 响应，再用 `npm run tail` 查看后台处理错误。

- **编辑后没有新增 Webhook 投递记录**：先确认查看的是正确的翻译 App，并检查 **Webhook → Active**、已保存的事件订阅，以及 App 对目标仓库的安装授权。GitHub 的“edited”标记不能证明这个 App 已收到事件；用实际文字变化测试，再查看对应的 `edited` 投递记录。没有投递时，应先检查 GitHub 事件配置，而不是修改 Worker 或模型超时。详见[查看 Webhook 投递](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)。
- **`401 Invalid webhook signature`**：检查是否在正确的 Worker 上配置了 `GITHUB_WEBHOOK_SECRET`，并确认它与 GitHub 中的值完全一致。
- **`404 Not found`**：GitHub 必须向 `/webhook` 发送 `POST` 请求；根地址仅用于健康检查。
- **`200 ignored owner`**：仓库所有者名称与 `TARGET_OWNER` 不匹配。
- **`200 ignored private repository`**：私有仓库处理未开启。确认准备翻译其内容后，才将 `ALLOW_PRIVATE` 设为 `"true"` 并重新部署。
- **`200 ignored action` / `200 ignored`**：动作或事件不在支持范围内。签名有效的 `ping` 会返回 `200 pong`。
- **标题可以翻译，评论或 Review 没有翻译**：部署当前代码，在 **Permissions & events → Subscribe to events** 中勾选全部五项事件。讨论评论使用 `issue_comment`（`created`／`edited`），行内评论使用 `pull_request_review_comment`（`created`／`edited`），Review 正文使用 `pull_request_review`（`submitted`／`edited`）。在 Recent Deliveries 中检查 `X-GitHub-Event` 与动作。编辑标题或正文不会翻译已有评论；需要在打开的 PR／Issue 上触发或重投该来源自己的事件。空白或未提交的 Review 会被跳过，Review 和行内评论的译文出现在 Conversation 中。
- **`400 Invalid JSON` 或缺少字段的响应**：签名有效，但载荷格式错误或缺少必要的安装、仓库、PR／Issue、评论或 Review 字段；检查事件载荷，尤其是手动构造的测试请求。
- **`202 accepted`，但没有评论**：在 `npm run tail` 中查看队列执行日志。临时失败会显示延迟重试；永久失败或次数耗尽会进入死信队列。已关闭的 PR／Issue 会被跳过。检查 GitHub Secrets、App 安装与权限、服务配置、模型访问、配额和 API Key Secret 名称。
- **入队时 Webhook 返回 `503`**：确认 `pr-translator-jobs` 已创建、生产者绑定已部署，以及账号的 Queues 操作限额未耗尽。修复后重新投递 GitHub 事件。
- **`GITHUB_PRIVATE_KEY must be PKCS#8`**：转换私钥，上传完整的 `BEGIN PRIVATE KEY` PEM 内容，不要上传文件名。
- **日志中出现 GitHub API `401` / `403`**：检查 App ID、私钥、安装范围和已批准的仓库权限。
- **评论写权限缺失，或 GitHub 请求返回 `403`**：查看 `GitHub installation permissions:` 日志。推荐的 **Issues → Read and write** 与 **Pull requests → Read-only** 或更高权限覆盖完整范围。保存 App 权限修改后，由安装账号批准更新。确认修改的是 `GITHUB_APP_ID` 对应的 App，且安装范围包含目标仓库，再重新投递支持的来源事件。机器人会在调用翻译模型前检查已批准的评论写权限并读取原文；切换翻译服务或重新部署 Worker 都不会授予缺失的 GitHub 权限。
- **服务返回 `404`**：检查模型 ID 和 `base_url`。填写 API 前缀，不是完整接口路径；OpenAI 兼容 Chat Completions 站点应使用 `type: "openai"`。
- **服务返回 `402` / `429`**：检查配额、计费与速率限制。剩余时间允许时，机器人会尝试下一项。队列模式下，全部服务失败且含 `429` 临时失败时可以延迟重试；单独的 `402` 视为永久性的计费问题。
- **返回格式无效或 JSON 模式报错**：检查站点响应格式是否与所选 `type` 匹配。不支持 JSON-object 模式的 OpenAI 兼容站点，可将 `json_mode` 设为 `false`；译文仍必须是包含所需字段的有效 JSON。
- **访问到列表最后一项前已超时**：缩短各项 `timeout_ms`、调整列表顺序，或在允许范围内调整 `TRANSLATION_TIMEOUT_MS`。所有尝试共用一个总预算。
- **未配置服务列表时 Gemini 超时**：单次 Gemini 尝试使用完整总预算，队列模式默认 60 秒。日志会显示实际超时上限、成功时的耗时，以及超时发生在等待响应头还是读取响应正文的阶段。队列模式会自动重试临时失败；显式服务列表中的每项仍默认 8 秒，可通过 `timeout_ms` 调整。上游持续失败时，仍需要可用的服务或备用接口。

## 安全与限制

- **凭据安全：** 使用原始请求体进行 HMAC-SHA256 签名验证。GitHub 请求通过 RS256 App JWT 获取短期安装令牌，无需个人访问令牌。不要提交 API Key 或私钥；`.gitignore` 已排除 `.dev.vars*`、`.env*`、`*.pem` 和 `*.key`。
- **私有内容：** PR／Issue 的标题与正文、讨论评论、行内审查评论及 Review 正文可能发送给列表中实际尝试到的任一服务，包括第三方 API 站点。默认禁用私有仓库处理；启用前应确认列表中的所有服务都可信，并检查其数据使用条款。使用 Gemini 时，也请查看 [Gemini 数据使用条款](https://ai.google.dev/gemini-api/terms)。
- **翻译保真：** 提示词要求模型保留 Markdown、链接、代码、HTML 标签与属性、时间戳、标识符、路径、URL、Issue 编号和提及。JSON 输出会被解析并检查所需字段，但格式保留及混合语言处理依赖模型输出。
- **文本长度：** 每条描述、原评论或 Review 正文只翻译前 **12,000 个 UTF-16 代码单元**。超出时，译文中会附带截断提示。
- **评论查找：** 最多检查前 **500 条讨论评论**，寻找带有译文标记的机器人评论。PR 标题／正文译文保留 `<!-- pr-translator-bot:v1 -->`，其他每个来源使用各自独立的标记；找不到时会新建译文评论。
- **范围与删除：** 来源必须属于打开的 PR／Issue。Review 与行内评论的译文发布在 PR Conversation。本机器人生成的内容会被跳过，防止循环；其他机器人发布的评论仍会处理。删除原文不会删除已经发布的译文，已有历史不会自动补翻。代码差异、提交评论和 GitHub Discussions 不会翻译。
- **投递与并发：** Queues 至少投递一次。默认消费者的批大小与最大并发数均为一，可降低评论竞争，但没有持久锁或全局幂等状态，重复投递与并发部署仍可能创建重复评论。每次符合条件的执行仍会请求翻译，即使最终生成的评论没有变化。详见[投递保证](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)。
- **处理时限与重试：** 队列模式的翻译预算默认 60 秒，每次可设置为最多 120 秒，并支持有限次数的延迟重试。重试可能再次调用模型并产生额外费用。队列无法保证不可用的 API 恢复成功；待处理和死信消息会按账号的保留期限过期。HTTP 后台模式维持较短时限，不会自动重试。

## 发布到 GitHub

提交源码、测试、`package.json`、`package-lock.json`、文档、`LICENSE`、`.gitignore`，以及占位值模板：`wrangler.example.toml`、`.dev.vars.example`、`translation-providers.example.json`。示例中的地址、账号、模型占位值与密钥应保持通用，便于其他人配置自己的部署。

实际 `wrangler.toml`、`.dev.vars`、`.env` 文件、私钥（`.pem`／`.key`）、`.wrangler/`、`node_modules/` 和生成的发布压缩包不应提交；`.gitignore` 已将它们排除。提交前检查 `git status --short` 与 `git diff --cached`，再将核对后的源码推送到 GitHub 仓库。新克隆的项目从部署第 1 步复制 `wrangler.example.toml` 开始。

### 自动测试与 Release

仓库包含两个 GitHub Actions 工作流：

- [CI](.github/workflows/ci.yml)：推送到 `main` 或创建、更新 Pull request 时，在 Node.js 22 和 24 上运行 `npm ci` 与 `npm test`。测试使用模拟 API，也包含 Worker 运行时中拦截的请求，无需真实模型凭据。
- [Release](.github/workflows/release.yml)：推送以 `v` 开头的标签时触发。先运行同样的 CI 检查，再验证标签等于 `v` 加 `package.json` 的版本号，且 `package-lock.json` 的项目版本一致；通过后创建 GitHub Release 并生成版本说明。任一检查失败都会阻止发布。

Release 在 GitHub 上通过工作流自动提供的 `GITHUB_TOKEN` 创建。这两个工作流不需要将 Cloudflare 凭据或模型 API Key 配置为 GitHub Actions secrets。GitHub 为标签提供 **Source code ZIP** 与 **TAR.GZ** 下载；工作流不会生成本地 `release/` 目录，也不会部署 Worker。使用者按[快速入门](#快速入门与日常使用)部署自己的实例。

版本含 `-`（例如 `v1.1.0-rc.1`）时会标为预发布。重新运行已发布标签的工作流会跳过重复创建；若同标签已有草稿，则需先手动发布或删除该草稿，再重新运行。

首次发布 `1.0.0` 时，先提交准备好的源码并推送到 `main`，再创建和推送对应标签：

```sh
git push -u origin main
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

此示例假设修改已核对并提交，且 `origin` 已指向你的 GitHub 仓库。推送标签后，在 **Actions → Release** 查看执行结果，再到 **Releases** 查看已发布版本。

后续发布补丁版本时，更新 npm 版本与锁文件，提交后给该提交打标签。例如当前版本为 `1.0.0`：

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release v1.0.1"
git push origin main
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

其他需要包含在版本中的修改也应在打标签前提交。两处标签命令都要使用更新后的实际版本，示例中的 `v1.0.1` 仅对应第一次补丁升级。仓库或组织策略不允许创建 Release 时，检查 **Settings → Actions** 的权限设置与 Release 任务日志。

## 项目结构

```text
pr-translator-bot/
├── README.md                 # 英文文档
├── README.zh-CN.md           # 简体中文文档
├── LICENSE                   # MIT 许可证
├── .dev.vars.example         # 使用占位值的本地凭据模板
├── translation-providers.example.json # 按优先级排列的翻译服务模板
├── .gitignore                # 排除本地凭据与私钥
├── .github/workflows/
│   ├── ci.yml                # 推送与 Pull request 自动测试
│   └── release.yml           # 测试通过后发布 v* 标签
├── package.json              # npm 命令与 Wrangler 依赖
├── package-lock.json         # 固定依赖版本
├── wrangler.example.toml     # 可公开的 Worker 配置模板
├── wrangler.toml             # 本地部署配置，已被 Git 忽略
├── src/
│   ├── index.js              # Webhook／队列处理、认证与评论
│   ├── github.js             # GitHub 认证、请求与译文查找
│   ├── content.js            # Issue、评论与 Review 翻译任务
│   └── translation.js        # 服务适配、校验与自动切换
└── test/
    ├── webhook.test.js       # 签名验证与 JWT 签名
    ├── integration.test.js   # 模拟评论流程与私有仓库过滤
    ├── comment.test.js       # PR Conversation 事件、归属校验与更新
    ├── content.test.js       # Issue、讨论评论、行内评论与 Review
    ├── queue.test.js         # 持久保存、权限、重试与死信
    ├── runtime.test.js       # 真实 Worker 运行时与拦截的 API 请求
    ├── runtime-queue.test.js # 真实 Worker 运行时中的原生队列处理
    └── translation.test.js   # 服务配置、接口格式与自动切换
```

## 许可证

本项目采用 [MIT 许可证](LICENSE)。允许使用、修改、分发及商用，须在软件的所有副本或重要部分中保留版权与许可声明。软件按现状提供，不提供担保。
