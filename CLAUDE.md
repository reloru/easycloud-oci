# easycloud-oci

A mobile-first web app that provisions free Oracle Cloud (OCI) servers inside a
non-technical person's **own** OCI account, then hands them full control. The
app replicates a reference configuration that has already been proven in
production. The configuration is defined in `docs/PLAN.md`.

## Start here (every session)
1. Read this file. Then read the **Status** section of `docs/PLAN.md`, which
   gives the current milestone, the next action, and any blockers.
2. Do the next action.
3. After each meaningful step, and always before ending:
   - Update `docs/PLAN.md`: Status, milestone checkboxes, decisions, and open
     items.
   - Update this file if the rules or the layout changed.
   - Merge to `main` (see Git below).

   A new session must be able to resume from the repo alone.

## Layout
| Path | Purpose |
|---|---|
| `CLAUDE.md` | Operating rules and repo map (this file) |
| `docs/PLAN.md` | Living plan: status, decisions, milestones, open items, sources |
| `.claude/settings.json`, `.claude/hooks/auto-approve.sh` | PreToolUse hook that auto-approves all tool calls so there are no in-chat permission prompts. It blocks force-pushes, deleting or rewriting `main`, and `rm -rf` of `/` or `~`. |
| `worker/` *(planned, M1)* | Cloudflare Worker (TypeScript): OCI request signing, orchestration, Durable Objects |
| `web/` *(planned)* | Static mobile frontend |

## Working rules
- **Earned-space check.** Before spending significant time on one thing,
  confirm it moves the current milestone forward. If it doesn't, log it under
  Open items in `docs/PLAN.md` and move on.
- **Extract, don't transcribe.** When the user describes an aspect of the app,
  pull out the actionable requirement or decision. Record it in your own words
  as a decision, requirement, or open item. Never put the user's messages, or
  a summary of them, anywhere in the repo.
- **Answer the question asked.** Yes/no/maybe questions get direct answers. Do
  not widen the scope unprompted.
- **The user works from an iPhone.**
  - Any command he must run is a single copy-pasteable line.
  - When changing a file he already has, give the complete file, not a diff.
  - Never ask for private keys.
- **Sourcing.**
  - Prefer primary docs: Oracle, Cloudflare, WebKit.
  - Label unverified claims inline, where they appear.
  - Community-sourced claims say so.
- **Git.**
  - `main` is the state of record. A ruleset protects it: it requires a PR,
    allows only squash merges, requires linear history, and blocks force
    pushes and deletion. Zero approvals are needed, so a direct push to `main`
    is rejected.
  - Standard flow, which the user has standing-approved:
    1. Commit on a `claude/*` branch and push it.
    2. Open a PR with the GitHub MCP tools.
    3. Squash-merge it immediately.
  - After each merge, restart the branch from the new `main`:
    `git fetch origin main && git checkout -B <branch> origin/main`.
  - Use the commit trailer given in the session's system instructions.
  - Do not narrate git or PR mechanics in replies. Mention them only if
    something fails.

## Product rules (non-negotiable)
- **VM components are opt-in toggles.** The components are keep-alive, Docker,
  cloudflared, and Tailscale. Keep-alive is marked *recommended*.
- **Every installed component ships a control sheet.** The sheet gives
  single-line, copy-pasteable commands for:
  - status
  - edit (generated from a form, so no text editor is needed)
  - pause
  - resume
  - remove
  - uninstall-package (shown only if the app installed that package)

  The sheet is shown in the app at handoff **and** written onto the VM. The
  user keeps full control without the app and without programming knowledge.
- **Installs are namespaced (`easycloud-*`).** The VM keeps a manifest of what
  the app installed. Uninstall commands never touch packages that were already
  present.
- **The app only ever handles public SSH keys.** The user generates the key in
  Termius and pastes the public half; the app never handles a private SSH key.
- **Nothing is hardcoded that the API can report.** Read limits, storage use,
  existing VCNs, and images live from the API.
