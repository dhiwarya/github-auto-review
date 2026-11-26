# Auto Reviewer

A personal review agent that runs on your own machine. When someone requests your review on GitHub, it reviews the PR with your own Claude Code and Codex logins and leaves a **draft review that only you can see**. You edit it and submit it yourself. A local dashboard shows the queue, live progress and leaderboards.

## What a review covers

You choose which reviews each PR gets: every repo has its own set in Settings, and there are tick boxes when you add a PR by hand. Each review is its own model run, so fewer reviews use less of your subscription. All three are on by default.

The **Standard** profile uses one provider for the review: **Codex** by default (Sol 6.1, then Sol 6), with **Claude** taking over only if Codex runs out (Opus 5.5, then Opus 4.8). You can switch providers, or turn the fallback off, on the dashboard's Settings page. The **Strict** profile, chosen per repo, requires both providers, as described below.

Security reviews can trip a provider's safety filter (OpenAI may flag one as "possible cybersecurity risk"). That run then goes to the next model in the same order, ending with Claude if the fallback is on. Nothing is paused, since the refusal is about that PR, not the model. The security instructions say plainly that this is a defensive review of the team's own code, and never ask for exploit code or payloads.

| Review | Looks for |
| --- | --- |
| Code | Bugs, edge cases, error handling, concurrency, weak tests, breaking changes. |
| Security | Injection, auth gaps, secrets, SSRF, path traversal, unsafe deserialization, risky dependency or CI changes, each traced from input to sink. |
| Consistency | Whether the change agrees with everything around it: requirements in the linked GitHub issues that are **missing** or implemented **differently**, claims in the PR description the code doesn't back up, docs the change makes stale, and other open PRs that touch the same code. |

Then every blocker and major is double-checked in a second, separate run. Refuted findings are dropped, and uncertain ones are downgraded.

### The PR's job

Every review first works out what the PR is for, from its title, description, commits and linked issues. A PR often takes on one item of a larger issue or one step of a plan; then that is its job. The PR is reviewed against that job, and these are **outside it**:

- problems in files the PR doesn't change, unless its changes cause them or make them worse;
- items of a linked issue, later steps and follow-up work the PR doesn't take on;
- code, services and documents in other repositories, and other PRs' work, as long as the PR uses them as documented.

Anything outside the job is never a finding and never lowers confidence, so it can't hold back an approval, or the auto-merge that follows one. The review's page shows what the review took the PR's job to be and anything it left out; neither is posted. Scope never excuses a problem the PR's own changes introduce, or something the PR says it does but doesn't.

A finding from an earlier review can turn out to be outside the job, for example when the author replies that the PR doesn't touch that file. The next review checks that itself, since every earlier finding is listed with whether the PR changes its file, and if it holds, it stops counting the finding and lists it under **Outside this PR** with the reason. A reply alone isn't enough.

Instructions to an AI reviewer are reported as a security finding only when the PR adds them. Guidance already on the base branch, such as `AGENTS.md` or `CLAUDE.md`, is ordinary repository content, and a person on the PR asking for an approval is ordinary conversation. Neither is ever followed.

### Repo context

A repo can have **context**: markdown that explains how the system is meant to work, such as architecture, design documents, domain rules and conventions. It belongs to that repo alone: you set it up under the repo in **Settings → Repositories → Context**, from:

- **Context repositories**, such as a separate docs repo, optionally one folder of it.
- **Uploaded markdown**: a folder or files dropped onto the dashboard (`.md`, `.mdx`, `.markdown`, `.txt`; up to 20 MB at a time).
- **Notes** in your own words, given to every reviewer as written.

The markdown is read once into a graph in the app's database, the **baseline**. Every document and every heading section is a node. A section belongs to its parent, and a link in one section is an edge to the document or section it points at. Hidden folders (`.github`, `.kiro` and the like) and `node_modules` are left out.

Baselining parses files and runs no model, so it costs no subscription usage. A repo with a few megabytes of markdown takes seconds. It refreshes itself: before each review the context repositories are fetched, and only files that changed are read again. **Refresh baseline** in Settings does the same on demand.

Before a review's models run, the app looks the change up in the baseline:

1. It takes the words that describe the change: the PR title, linked issue titles, changed file names, and the names the diff adds most.
2. A keyword search (SQLite full-text search) finds the best-matching sections.
3. It follows the graph one step from each match, to the sections they link to or are linked from.
4. The result goes into the prompt of every review, with a list of the most-referenced documents, within a character budget (12,000 by default).

The context is reference material. It can't instruct the reviewer, and it is fenced like every other text the app didn't write. The review's page lists the sections it was given and the words that were looked up. **Try a search** in Settings shows what any wording would return.

Keyword search matches the words used, not their meaning: a PR and a document that describe the same thing in different terms may not meet. Context repositories are also checked out for the consistency review, which reports docs the PR makes stale.

### The consistency review

- **Docs.** Each repo's settings say where its docs are: folders or files in the repo, a separate docs repository, and any notes for the reviewer. A separate docs repo is checked out read-only next to the PR for the review. Left empty, the reviewer looks for docs in the repo itself.
- **Other open PRs.** The app compares the PR with the repo's 40 most recently active open PRs, using the local repo copy (one GitHub request in total), and shows the reviewer the ones that change the same files. What the reviewer makes of them is listed in the summary as **Related open PRs**: overlap, conflict or duplicate. These are alerts only. They are never findings, so they can't lower the confidence, stop an approval or request changes. A PR with no activity for 30 days (configurable) counts as unmaintained, and an alert about it is always low confidence.

After that, plain code (no model) checks each finding:
- The quoted evidence must really exist in the file.
- The file must exist.
- The comment must sit on a line GitHub accepts. If it doesn't, the finding moves to the summary.
- Duplicates and points already raised in an earlier review are removed.
- Nits are capped.
- Any credential in the output is redacted. If a credential appears that the PR itself didn't add, the finding is dropped as a possible exfiltration attempt.

Severity scale: **blocker**, **major**, **minor**, **nit**.

### Strict reviews

Strict and the review choice work together: Strict always reviews code, security and the linked issues itself, whatever is ticked under the repo's **Reviews**. With **Consistency** on, one more run on the primary provider checks the docs and the other open PRs after the Strict stages; requirements stay with Strict's checklist.

Strict is chosen per repo: pick the repo in **Settings → Repositories**, then **Reviews → Review profile → Strict**. Standard is the default for a new repo. Selecting Strict does not change the repo's dry run or draft/publish mode, or any other repo. Both Codex and Claude CLI logins are required.

Strict reviews run code/requirements and security passes on the primary provider, then a fresh adversarial pass on the other provider. The independent pass does not see the current review's other findings. Serious findings are verified in fresh runs on the provider opposite the one that raised them. Model fallback stays within the assigned provider; the Standard cross-provider fallback switch does not weaken this requirement.

The reviewer creates a manifest of code and context sections. Strict retrieves complete PR descriptions, linked issues, paginated comments and base-branch guidelines; it does not use Standard's fixed-size excerpts. Complete source snapshots are saved per job, with hashes and exact character ranges for each assigned section. Local copies inside the throwaway checkout remain available for cross-batch lookup. Every required pass must account for each assigned section and report the dependencies, tests and configuration it examined. Claimed file paths must exist inside the checkout. Large changes are split into bounded batches, followed by primary and independent consolidation checking interactions and finishing the requirement checklist. The independent consolidation sees only its own earlier assessments. Real minor findings are still included; the Standard large-PR top-risk restriction does not apply. Strict evidence must match a complete quoted block, allowing indentation differences. Requirement findings can instead quote actual linked-issue evidence.

The job page distinguishes source material included in a prompt, the model's reported examination, and its recorded tool activity. Coverage reports are evidence of the review process, not proof that a model understood the code. Exclusions stay visible. Missing sections, unavailable sources, exhausted budgets, or failed stages make the review incomplete. The app attempts targeted continuations, then retains an unfinished result locally instead of automatically publishing it. Recoverable provider outages wait; exhausted recovery requires action on the dashboard. A failed/cancelled incomplete result can be posted manually only after explicitly selecting the partial-review checkbox; a partial publish is a comment and never approves or requests changes.

Requirement assessments use the parent issue refs from the retrieved manifest. Citations to retrieved issue comments are normalized to their parent before checking completion and reviewer agreement. Unknown issues or nonexistent comment ordinals are rejected. Continuations receive the exact missing/unfinished criteria and valid refs, and retain completed code coverage without asking the model to repeat it. A completed assessment can still block approval when promised behavior is missing or acceptance remains externally unverified.

| Strict budget | Default |
| --- | --- |
| Time per model run | 1,800 seconds |
| Characters per run, including context and an instruction allowance | 500,000 |
| Review batches | 16 |
| Model attempts per job, including continuations, verification and model fallbacks | 64 |
| Continuations per stage | 2 |
| Attempts reserved for verification | 8 (when the planned workload leaves room) |
| Claude turns per run | 120 |
| Claude effort | High |

Successful, schema-valid stages are saved under their exact input fingerprint. After an unavailable provider recovers, only missing stages run again. A stage with missing coverage continues with the unexamined sections and merges the results. The app estimates discovery/consolidation work before running and reserves attempts for later stages and verification. Other stage failures use bounded job retries. Exhausted budgets require a new full review with suitable settings. Repeated calls count against the total job attempt budget, including calls from earlier attempts. Stored settings with the previous default 8 batches/32 attempts are upgraded once to 16/64; other custom values are preserved.

Requirements are assessed as a checklist. An issue the PR closes represents its promised full scope. An issue the PR only mentions is context: each criterion is marked as promised or not, and only what the PR takes on counts toward approval (if either reviewer reads a criterion as promised, it counts). A promised criterion that is deferred needs source-backed scope evidence, corroboration against the code, and independent reviewer agreement. Missing promised behavior still blocks approval. Operational/manual acceptance that cannot be established from code is recorded as externally unverifiable and blocks approval without making completed code coverage unfinished.

Strict approval always requires high confidence, complete required stages and coverage, no open blocker or major from any review, no unresolved serious verification, no material requirement gaps, and no unresolved review questions. The existing commit, draft-PR, self-approval, manual-change-request and credential checks still apply. The preview and actual post use the same decision. A failed verifier never silently qualifies a Strict review for approval. Uncertain serious concerns retain their severity and appear as clearly marked summary items for human inspection.

Each started job stores its review profile, policy version and effective settings. Retries retain that policy and successful source snapshot. An incomplete source fetch is retried rather than frozen permanently. Unposted jobs from the previous Strict policy are explicitly upgraded, retaining their old policy in the saved record and rebuilding full coverage before posting. More restrictive current approval settings also apply at posting; changing to Standard cannot remove a started Strict job's gates. Draft submission remains your decision. Strict adds no new automatic request-changes behavior to initial reviews.

Incremental reviews require complete current-policy Strict coverage at their baseline. Baseline confidence is separate: a complete earlier review containing a major finding is still a valid coverage baseline, and the open finding is checked independently. Missing, older-policy or incomplete baselines automatically expand the job into one full review of the current PR. Strict rechecks refresh full code/context coverage and the PR discussion while reassessing earlier findings; they do not raise new findings on an unchanged commit. **Full PR review** remains available for a fresh review with current settings and budgets. If you already have a pending GitHub review, submit or discard it before another can be posted.

## Lifecycle

```
review requested ─► queued ─► reviewing ─► posted ─► approved, or feedback
                                  │
       new commits pushed ────────┤ (follow-up review of only the new commits; fixed findings are listed)
       re-requested, no commits ──┤ (re-check of the findings still open; see below)
       request removed/PR closed ─┤ cancelled
       both models at their limit ┤ waiting until the limit resets
       you have a pending review  ┤ waiting until you submit or discard it
       3 failed attempts ─────────┴ failed (shown on the dashboard)
```

### Reviewing again

Submitting a review takes you off the PR's requested reviewers, as on GitHub for anyone. To get another review, the author **re-requests your review**:

- **With new commits:** a **follow-up check of the fixes**. The first review looked at the whole PR; this one is a single model run instead of three reviews, so it costs far less. It reads each finding still open from earlier reviews against the new code and what was said on the PR since, and says which are fixed, which are still open, and which are outside the PR's job, with a reason for each. It also reads the new commits for serious new problems, blockers and majors only: a fix that breaks something else. Smaller suggestions wait for the next full review, and the linked issue isn't checked again, so the last review's verdict on it stands. Confidence comes from this check, so a PR can be approved once everything is fixed.

  The whole PR is reviewed again instead, with every review, when the new commits change more than 400 lines, or more than half of a PR of over 100 changed lines, or when the branch was rebased or force-pushed so the last review no longer lines up. **Full PR review** on a review's page does the same on demand. To run every review on the new commits instead of checking the fixes, set **Settings → Repositories → Reviews → After the author pushes new commits** to *Review the new commits*. Strict reviews keep their own follow-up rules.
- **Without new commits:** a **re-check**. Nothing new is raised on code that was already reviewed. Each finding still open from earlier reviews is read again against the code and what was said on the PR since (replies in its thread, and the PR conversation), and stays open, is resolved, or is ruled outside the PR's job. A reply saying "fixed", "intentional" or "out of scope" only counts when the code and the PR's files confirm it. The review then:
  - **requests changes** while a blocker or major is still open,
  - **comments** when only minors or nits are,
  - **approves** when everything is resolved and the rules in [Confidence and approval](#confidence-and-approval) allow it.

  In draft mode it prepares the draft and the dashboard says which to choose when you submit it. A draft you haven't submitted, a discarded draft and a dry run leave you on the requested reviewers, so they never trigger a re-check; use **Re-check** on the review's page instead.

A PR carries one of these labels at a time. The names are set in Settings:

| Label | Meaning |
| --- | --- |
| `dh: on review` | Review in progress. In draft mode it stays until you submit the draft. |
| `dh: feedback` | Reviewed without approving. |
| `dh: approved` | Approved for you, or you submitted your draft as an approval. |

Adding labels needs triage access. If the token can't add them, the review still works, and the summary carries a hidden marker instead. Labels from earlier versions (`ai-review:*`) are taken off a PR when it gets a new one.

## Comments

Written for the PR's author to read quickly. Plain markdown, no emoji, no model details. The summary has:

1. **A one-line verdict:** `Approved. Nothing blocking.`, `Looks good. 2 small suggestions, nothing blocking.`, `Needs changes. 1 blocker, 2 major.`, `Looks good, but I'm not approving yet.` or `Partial review.` It matches what was actually posted, because the comment is written again right before posting.
2. **A short summary:** what the PR does and whether it does it correctly, from one review (the others stay on the dashboard). It names the linked issue only when the PR doesn't fully match it, and mentions what was fixed since the last review.
3. **Needs fixing / Suggestions:** findings that aren't on a changed line. The rest are inline comments, which read `**Major:** title`, then the problem and a suggestion.
4. **Not approving yet:** at most two plain reasons the author can act on, plus any open questions. Internal reasons (approving switched off for the repo, confidence levels, review bookkeeping) stay on the dashboard.
5. **Questions** (at most three, repeats merged) and **Heads up** (other open PRs), only when there are any.
6. A small footer naming the reviews that ran, the commit, and any skipped files.

Each section appears only when it has something in it. Comments carry no signature; hidden markers tie them back to the review and its findings.

## Confidence and approval

Every review gets a confidence level: how sure it is that nothing blocks the PR. It starts at high and drops for anything that leaves doubt:

| Lowers it to | When |
| --- | --- |
| Low | The code review or the security review was switched off |
| Medium | The consistency review was switched off, so the linked issue and docs weren't checked |
| Medium | A major finding is open, there are questions for the author, the code leaves out part of what it promises from the linked issue, the change is large, or the diff was too long to send in full |
| Low | The code doesn't match the linked issue, or the PR tried to get a credential out of the reviewer |
| Either | A review pass rates its own confidence lower, saying what it couldn't check within the PR's job |

A published review **approves the PR** when nothing is open, in this review or an earlier one on the PR, whatever its confidence. With findings open, it approves when none is a blocker and the confidence is at least the minimum set in Settings (high by default). A PR that tried to get a credential out of the reviewer is never approved, and Strict reviews keep their own rules. It never approves a draft (you decide when you submit it), a draft PR, your own PR, a PR with commits newer than the review, or one where you requested changes yourself. A change request the app published from a re-check doesn't count as yours: approving replaces it. Otherwise it posts a comment review, and the dashboard says why it didn't approve. An approval counts toward branch protection, so the PR may become mergeable.

### Auto-merge

Off by default, and set per repo. When it's on, the app merges a PR once all of these hold:

- Your standing review approves the PR's latest commit. That's an approval the app published, or a draft you submitted as an approval yourself.
- Nobody else's standing review requests changes.
- GitHub says it can merge: required checks passed, branch rules met, no conflicts. A check that is failing or still running holds it, even one that isn't required.
- The wait after the approval is over (10 minutes by default), and you haven't held the PR.

The app merges only the commit that was approved: if a push lands in between, GitHub refuses the merge. It never merges during a dry run, a draft PR, or a PR in a repo that is switched off. If GitHub refuses, the reason shows on the Pull requests page and the app tries again after 30 minutes, or sooner when the PR changes. The method (squash, merge commit or rebase) is set per repo, and the branch can be deleted afterwards. Merging needs write access: for a fine-grained token, Contents: write.

## Safety model

- **Only the repos you list in Settings** are ever reviewed. Keep public repos where strangers open PRs out of that list.
- **Read-only agents.** Claude runs as `claude -p --restricted --tools Read,Grep,Glob`, with no MCP servers and no project settings or hooks loaded from the PR, so it can only read files. Codex runs as `codex exec --sandbox read-only`, with no user config, no rules and no `AGENTS.md`. Codex works through shell commands, so its instructions forbid running, building, installing or testing anything from the repository. Its sandbox also blocks file writes and network access, and any credential that shows up in its output is dropped.
- **The agents never get your GitHub token.** They get an allowlisted environment, and their only output is JSON. The app does all GitHub writes itself.
- **Nothing posted can carry a credential.** Every finding, summary, question and note is checked for secret formats (GitHub, Anthropic, OpenAI, AWS, Slack, private keys, JWTs). A secret the PR doesn't add itself is redacted and lowers the confidence to low. Right before posting, the whole review is also checked against the app's own credentials, word for word: the GitHub token, the Claude token and the Codex and Claude login files. A match stops the post and fails the review.
- **Throwaway checkouts.** Each review gets its own worktree of the PR head in a temp folder, made from the local repo copy, with symlinks disabled. It's deleted afterwards. Your GitHub token is passed to git through the environment and never written into the local copy.
- **Approves only under strict rules, and requests changes only from a re-check.** Draft mode posts a pending review. Publish mode approves when the rules in [Confidence and approval](#confidence-and-approval) allow it, requests changes when a [re-check](#reviewing-again) finds a blocker or major still open, and posts a comment review otherwise. Text in a PR can't raise the confidence: the hard rules are checked by the app, not the model.
- **Merges only when you turn it on.** [Auto-merge](#auto-merge) is off for every repo until you switch it on, merges only the commit you approved, and waits for GitHub's own checks and branch rules.
- **Local dashboard.** It listens on `127.0.0.1` only, rejects foreign `Host` headers (DNS rebinding), and requires a custom header on every write (CSRF).
- **Subscription terms.** It drives the official `claude` and `codex` CLIs with your own logins, for your own review queue. Don't share one instance with teammates. Each person should run their own.
- **Company code.** These reviews send your repos' code to your personal Claude and ChatGPT accounts. Check that your employer allows it, and turn off model training in both accounts.

## Setup

Requirements: Node 22.18 or newer, `git`, and the [GitHub CLI](https://cli.github.com) (or a token). You also need [Claude Code](https://code.claude.com) and/or the [Codex CLI](https://developers.openai.com/codex). One of the two is enough: the app falls back to whichever is available.

```bash
npm install
npm run build
```

Sign in to each tool:

```bash
gh auth login
```

```bash
claude auth login
```

```bash
codex login
```

A fine-grained GitHub token is optional but recommended. It limits the bot to the repos it reviews (`.env.example` lists the scopes). Without one, the app uses your `gh` login.

```bash
cp .env.example .env
```

Start it:

```bash
npm start
```

Open http://127.0.0.1:4477, go to **Settings**, and add the repos to review. Nothing is reviewed until you do.

A new repo starts in **dry run**: reviews run and appear in the dashboard, but nothing is posted. Once the findings look right, turn dry run off for that repo in Settings.

### Start at login

| OS | Command |
| --- | --- |
| macOS | `sh deploy/macos/install.sh` (remove with `sh deploy/macos/install.sh remove`). Logs go to `data/reviewer.log`. |
| Linux | Follow the steps at the top of `deploy/linux/auto-reviewer.service` (systemd user service) |
| Windows | `powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1` (Task Scheduler) |

### Run in Docker

The image has everything the app runs: Node, git, ripgrep, Claude Code and Codex. Docker keeps it running, and starts it again with Docker, until you stop it. Only Docker is needed on the machine.

Sign in once. A container can't use your computer's own logins, so each tool gets its own:

1. GitHub: put a token in `.env`. The quickest is your `gh` login; a fine-grained token (scopes in `.env.example`) is safer.

   ```bash
   echo "GITHUB_TOKEN=$(gh auth token)" >> .env
   ```

2. Claude: run `claude setup-token` on your computer. It opens the browser and prints a long-lived token for your subscription. Add it to `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`.

3. Codex: sign in inside the container. It shows a code to enter at a link, and keeps the login in a Docker volume.

   ```bash
   docker compose run --rm auto-reviewer codex login --device-auth
   ```

4. Set `TZ` in `.env` to your time zone, for example `TZ=Europe/Berlin`, so the pause window uses your local time.

Then:

| To | Run |
| --- | --- |
| Start | `docker compose up -d --build` (or `npm run up`) |
| Stop | `docker compose down` (or `npm run down`) |
| Follow the log | `docker compose logs -f` (or `npm run logs`) |

The dashboard is at http://127.0.0.1:4477, published on this machine's loopback only. The `data` folder is shared with the container, so settings and history are the same as with `npm start`. Run only one of the two at a time. Stopping keeps queued and interrupted reviews; they continue on the next start.

The CLI versions are pinned in the `Dockerfile` (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`). Change them and start again with `--build` to update. On Linux, the container runs as user ID 1000, so the `data` folder must be writable by it.

To open the dashboard from your other devices over Tailscale, proxy it with Tailscale Serve on the machine running it (`tailscale serve --bg 4477`, which needs `sudo` or `tailscale set --operator=$USER` once), and add the machine's Tailscale name to `.env` as `ALLOWED_HOSTS=my-server.tailnet-name.ts.net`. It's then at `https://my-server.tailnet-name.ts.net` for every device on your tailnet, and nowhere else.

Codex runs each command in a read-only, offline sandbox, which needs Linux namespaces that Docker's default seccomp profile blocks. So `compose.yaml` turns seccomp off for this container, and in exchange drops every capability and blocks privilege escalation. On Linux hosts that restrict unprivileged user namespaces through AppArmor (Ubuntu 23.10 and later), also add `apparmor=unconfined` under `security_opt`.

## Dashboard

- **Queue:** live progress of running reviews, queued and waiting work, history, and a box to review any allowlisted PR on demand.
- **Pull requests:** every PR with a finished review: your review as it stands on GitHub (approved, changes requested, commented, or a draft not submitted yet), whether it's on the latest commit, other reviewers' change requests, whether the PR is open, merged or closed, and what auto-merge is doing. You can hold or resume auto-merge for any PR. The status comes from GitHub, so a review you submitted or changed by hand shows up too. A PR is checked again only when GitHub's open-PR list shows it changed, which the app fetches anyway. PRs waiting on checks are the exception and are checked once a minute. PRs in a repo you no longer watch are looked up once an hour while they're open.
- **Job page:** the review from start to end, live while it runs:
  - **Evidence:** the diff (which files were in the prompt, too long to send, or excluded), linked issues, mentioned PRs, guidelines, file history and the prompt size.
  - **Code review and security review:** model, time, tokens in and out, tool calls, what each returned, and a step-by-step log of every command, tool call and reasoning note (click one for its output).
  - **Double-check, checking findings against the code, and posting.**

  Below that: every finding (including discarded ones and why), the timeline and the review text. In dry run, the review text is what would have been posted.
- **Leaderboard:**
  - **Models:** keep rate per model and pass, refuted findings, findings with bad evidence, speed, failures, and average tool calls and tokens per run.
  - **Repos:** clean-PR rate, findings per PR, blockers, security findings, requirement gaps.
  - **Authors:** the same metrics per author. They stay on your machine.

The keep rate is learned automatically. After you submit a draft, the app checks which of its comments you kept, edited or deleted.

## Settings

Everything is set on the dashboard's **Settings** page and stored in the app's database (`data/reviewer.sqlite`). A save is checked as a whole and applies without a restart. A review keeps the settings its repo had when it started; model and review-budget changes apply to new jobs, while stricter approval restrictions also apply before posting.

Settings come in two parts.

**Repositories** holds one entry per repo, and each repo has its own settings. Only repos with an entry are ever reviewed. An entry can also be a pattern such as `owner/*`: it covers every repo it matches that has no entry of its own. Adding a repo starts it from the defaults below, or you can copy the review settings of another repo.

| Section | Setting | Default for a new repo |
| --- | --- | --- |
| Repository | Review pull requests here | On. Off keeps the settings and context without reviewing |
| Posting to GitHub | Dry run | On |
| | How reviews are posted | Draft |
| | Approve PRs that have no blockers | On: always with no findings open; with findings, when confidence is at least high |
| Auto-merge | Merge approved PRs | Off; when on: squash, 10 minutes after the approval, branch kept |
| Reviews | Review profile | Standard; select Strict for independent review and required coverage |
| | After the author pushes new commits | Check the fixes (one run); a full review after a big change or a rebase |
| | Code / Security / Consistency | All on |
| Context | Context repositories, uploads and notes | None |
| Docs and other PRs | Where the docs are | Not set: the reviewer looks in the repo itself |
| | Another open PR is unmaintained after | 30 days without activity |
| Files and authors | Leave out of reviews | Lockfiles, vendored and generated files |
| | Skip PRs by | dependabot, renovate, github-actions |
| Labels | While reviewing / Left feedback / Approved | `dh: on review`, `dh: feedback`, `dh: approved` |

**App** holds what every repo shares, because it comes out of the same subscriptions:

| Section | Setting | Default |
| --- | --- | --- |
| Reviewer | Who reviews | Codex |
| | If Codex runs out, use Claude instead | On |
| | Double-check blockers and majors | On |
| | Codex models | `gpt-6.1-sol`, then `gpt-6-sol` |
| | Claude models | `claude-opus-5-5`, then `claude-opus-4-8` |
| Schedule | Check GitHub every | 5 seconds (one request per watched repo, free when nothing changed) |
| | Most reviews per hour | 6, across all repos |
| | Pause during part of the day | Off |
| | Rest a model after a usage limit | 30 minutes |
| Review limits | Large PR above | 1,500 changed lines (then only blockers and majors) |
| | Most nits per review | 5 |
| Strict review budgets | Batches, model attempts and time per run | 16 batches, 64 attempts, 30 minutes |

Two things are set in `.env` instead, because the app needs them before the dashboard exists: `PORT` (default 4477) and `DATA_DIR` (default `./data`).

Upgrading from a version with one set of settings for all repos: the first start turns them into one entry per repo you had listed, each with the values that applied to it, so reviews carry on as before. Repos on the old "never review" list become entries that are switched off.

Upgrading from a version that used `reviewer.config.json`: the app imports that file the first time it starts, then renames it to `reviewer.config.imported.json`.

## How it watches GitHub

The app checks each watched repo's list of open pull requests and looks for ones that request you. Each check is a *conditional* request: it sends back the version it saw last time, and when nothing changed GitHub answers "304 Not Modified", which doesn't count against your rate limit. With nothing new happening, checking every 5 seconds costs nothing.

- Exact entries (`owner/repo`) are watched directly. Patterns (`owner/*`) are matched against the repos your login can access, a list refreshed every 10 minutes.
- Requests are sent one at a time, at least a second apart, so a long repo list stretches the cycle instead of bursting.
- If GitHub says the rate limit is reached, polling waits for the reset. If it asks the app to slow down without saying for how long, polling backs off for 1, 2, 4, 8 and then 15 minutes.
- Polling also stops while fewer than 300 requests are left in the hour, so posting reviews keeps working.
- Settings → App → GitHub usage shows each limit and what the last check cost. Each repo's entry shows what the app sees there.

Each copy of the app shares your account's limits with everything else on your login, so run one copy per login.

## Local repo copies

The first review of a repo downloads a full copy into `data/repos/`. Later reviews fetch only new commits, and each gets a throwaway worktree. From the local copy the app reads:
- diffs for follow-up reviews, and for big files whose diff GitHub leaves out
- the repo's guideline files from the base commit
- the recent history of each changed file, which goes into the prompt

That saves GitHub requests and gives the reviewer history to work with. The copies use as much disk as a normal clone. Deleting `data/repos/` is safe: it's downloaded again on the next review.

## Development

| Command | Does |
| --- | --- |
| `npm run dev` | API with auto-reload on port 4477 |
| `npm run dev:web` | Dashboard with hot reload on port 5173 (proxies to the API) |
| `npm test` | Tests for validation, review workflows, approval gates, routing, persistence and Strict coverage |
| `npm run typecheck` | Type-check the API and the dashboard |
| `npm run eval:strict -- results.json` | Compare human-adjudicated fixture reviews by profile |

The server runs TypeScript directly through Node's type stripping, so it has no build step. Only the dashboard is built, with Vite. State lives in `data/reviewer.sqlite`, using Node's built-in SQLite.

For environments that restrict the test runner's child processes, use `node --test --test-isolation=none test/*.test.ts`. The POSIX git-remote and shell-stand-in suites remain explicitly skipped on Windows.

Quality evaluation fixtures live in `test/fixtures/strict-reviews.json`. Run both profiles against the same fixtures, then have a human match each finding to an expected defect (or label it a false positive). Supply a JSON object with a `reviews` array. Each row has `caseId`, `profile` (`standard` or `strict`), `complete`, `durationMs`, nullable `inputTokens`/`outputTokens`, and `findings: [{ "matchedExpectedId": "expected-defect-id-or-null" }]` (use JSON `null` for a false positive). The evaluation command reports precision, recall, duplicates, incomplete runs, missing cases, runtime and token usage. These small synthetic fixtures support repeatable comparisons; mock-provider workflow tests do not establish real-model detection quality.

## Known limits

- One pending review per person per PR is a GitHub rule. If you're mid-way through your own review, the bot waits for you to submit or discard it.
- Requirement checks read GitHub issues only: issues the PR closes and issues mentioned in its description.
- A PR's `CLAUDE.md` may still be read by Claude as project memory. The instructions treat all repository content as untrusted, and draft mode means you see everything before anyone else does.
