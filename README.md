# pi-workspace-builder

A Pi extension that prepares a multi-repository workspace with independent clones and **new feature-branch worktrees**, then stops. It does not implement features, write feature plans, install project dependencies, or start an agent turn.

## Install

Requires Pi, Git, and Node.js 22.18+ (for the dependency-free TypeScript tests).

```sh
pi install git:github.com/stephen-melsom-s1/pi-workspace-builder
```

For local development, load directly from your checkout:

```sh
pi install /absolute/path/to/pi-workspace-builder
```

Alternatively, link the checkout into Pi's global extension directory:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s ~/Code/pi-workspace-builder ~/.pi/agent/extensions/pi-workspace-builder
```

Choose one installation method to avoid duplicate commands. Run `/reload` in an existing Pi session, or start a new session. Local installs and symlinks load the checkout directly; there is no build step or runtime dependency to install.

## Use

```text
/workspace create
```

The wizard asks for:

1. Workspace name and purpose.
2. Parent directory (default `~/Workspaces`).
3. Repositories: GitHub `owner/repo`, HTTPS/SSH Git URLs, absolute local paths, or known sources discovered under the selected parent directory.
4. A directory name and writable/reference-only mode for each repository.
5. A new feature-branch name (default the workspace name), with optional per-repository overrides.
6. Confirmation of the full workspace preview.

Press Enter to accept defaults, or Escape to cancel a questionnaire dialog. Cancellation before creation writes nothing. An all-reference workspace skips the branch questions.

Known repositories are suggestions derived from local Git remote metadata, not reused working copies. GitHub sources are deduplicated by owner/repository, ignoring `.git`, letter case, and standard SSH/HTTPS URL differences; the first discovered clone URL is kept unchanged. Discovery checks direct repositories, workspace-level plain clones, and `<repo>-worktrees/main` clones; it does not recursively scan repository contents. Credential-bearing or unsupported remotes and unreadable directories are skipped.

### Created layout

```text
~/Workspaces/search-experiment/
├── AGENTS.md
├── feature-plans/                  # Empty; no feature planning started
├── app-worktrees/
│   ├── main/                       # Independent main clone; read-only by convention
│   └── feature%2Fsearch-experiment/ # New feature/search-experiment branch
└── reference-worktrees/
    └── main/                       # Reference-only; no feature branch
```

Branch directory names are URI-encoded: `feature/search` becomes `feature%2Fsearch`, while `DS-search` stays `DS-search`. The branch itself keeps its original name. The preview and generated `AGENTS.md` show the mapping.

Each source must contain `main`. Writable repositories get a **new** branch from `main`; existing remote branch names and conflicting branch prefixes are refused. There is no existing-branch selection, alternate-base selection, force-reset, or branch pushing. Clones include remote branches so collisions can be checked. Local sources are cloned without hardlinks or shared object storage.

`AGENTS.md` records the purpose, repository table, feature worktree paths, and rules prohibiting edits/commits in `main/` and changes to reference-only repos. It also directs agents to read each repository's own instructions. The workspace root is not initialized as a Git repository.

When finished, the extension prints a command to start Pi in the workspace. It does not change the current session's working directory or launch a new one.

## Safety and limitations

- No filesystem changes before confirmation. Remote access/main/branch checks run after confirmation but before workspace creation.
- Existing destinations (including symlinks) are refused. Repository names must be unique, ignoring case; aliases allow similarly named repos from different organizations.
- Git commands use argument arrays, not a shell. Supported remote transports are HTTPS and SSH; embedded URL credentials, query strings, and remote-helper transports are rejected.
- Uses existing Git authentication. For GitHub CLI credentials, configure Git once with `gh auth setup-git`, or use an SSH URL. The extension never asks for tokens.
- Git hooks are disabled for setup commands. Your Git credential helpers, SSH configuration, and checkout filters may still run; clone only repositories and use configurations you trust.
- Raw Git diagnostics are not displayed because URL rewrites and tracing can expose credentials. On failure, check access/authentication in your own terminal; do not share unredacted logs.
- Git operations have a five-minute timeout. After confirmation, setup runs to completion or failure; Escape cancellation during cloning is not implemented.
- If setup fails after creation starts, completed clones/worktrees and the partial workspace are preserved. The error identifies the failed step and completed steps. `AGENTS.md` describes the intended layout, so check that report before using a partial workspace. Automatic resume/cleanup is not supported.
- **Read-only is a workflow rule, not filesystem or Git permission enforcement.**
- Native dialogs work in Pi's terminal UI and with dialog-capable RPC clients. Noninteractive print/JSON mode is not supported.

## Development

```sh
npm test
pi -e ./index.ts
```

Tests use Node's built-in runner and temporary local Git repositories, require no credentials or network, and cover the questionnaire, cancellation, validation, clone/worktree creation, reference-only repos, remote-branch collisions, and failure reporting. A smoke test also runs the installed `pi` CLI with isolated configuration and native RPC dialogs, checking that no model turn starts. No npm install is needed to run them.

Remove a local global install with:

```sh
pi remove /absolute/path/to/pi-workspace-builder
```

If installed using the symlink method instead, remove only the link:

```sh
rm ~/.pi/agent/extensions/pi-workspace-builder
```
