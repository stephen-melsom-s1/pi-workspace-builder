import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export type Exec = (command: string, args: string[], options?: {
  cwd?: string; timeout?: number; maxBuffer?: number;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Repository = {
  source: string;
  name: string;
  referenceOnly: boolean;
  branch?: string;
};

export type WorkspacePlan = {
  name: string;
  purpose: string;
  root: string;
  repositories: Repository[];
};

export function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value.startsWith("~")) throw new Error("Use ~ or ~/path, not ~username.");
  return resolve(value);
}

export function validateName(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || Buffer.byteLength(value) > 100) {
    throw new Error("Use a name starting with a letter or number, containing only letters, numbers, dots, underscores, or hyphens (max 100 bytes).");
  }
}

export function parseRepository(input: string): { source: string; name: string } {
  let source = input.trim();
  if (!source || /[\x00-\x1f\x7f]/.test(source) || (/\s/.test(source) && !isAbsolute(source) && !source.startsWith("~/"))) {
    throw new Error("Enter owner/repo, an HTTPS/SSH Git URL, or an absolute local path. Only local paths can contain spaces.");
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) source = `https://github.com/${source}.git`;
  if (source.startsWith("~/")) source = expandPath(source);
  let repoPath: string;
  if (isAbsolute(source)) {
    repoPath = source;
  } else if (/^[a-zA-Z0-9_][\w.-]*@[a-zA-Z0-9][\w.-]*:[\w./~-]+$/.test(source)) {
    repoPath = source.slice(source.indexOf(":") + 1);
  } else {
    let url: URL;
    try { url = new URL(source); } catch { throw new Error("Unsupported repository source. Use owner/repo, HTTPS, SSH, or an absolute local path."); }
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname || url.hostname.startsWith("-") ||
        url.password || url.search || url.hash || (url.protocol === "https:" && url.username)) {
      throw new Error("Use an HTTPS/SSH URL without embedded credentials, query parameters, or fragments.");
    }
    repoPath = url.pathname;
  }
  const name = basename(repoPath.replace(/\/$/, "")).replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
  validateName(name);
  return { source, name };
}

export function branchDirectory(branch: string): string {
  const directory = encodeURIComponent(branch);
  if (!branch || branch.toLowerCase() === "main" || /[\x00-\x1f\x7f]/.test(branch) ||
      branch.startsWith("-") || branch.startsWith("@") || directory === "." || directory === ".." ||
      Buffer.byteLength(directory) > 200) {
    throw new Error("Choose a new feature branch (not main); its encoded directory name must fit within 200 bytes.");
  }
  return directory;
}

export async function git(exec: Exec, args: string[], cwd?: string): Promise<string> {
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await exec("git", ["-c", "credential.interactive=false", "-c", `core.hooksPath=${devNull}`, ...args], {
      cwd, timeout: 300_000, maxBuffer: 1_048_576,
    });
  } catch {
    throw new Error("Unable to run Git. Check that Git is installed and authentication is configured. Diagnostics omitted to protect credentials.");
  }
  // Git diagnostics can contain credentials from URL rewrites or trace settings, even with a safe source URL.
  if (result.code !== 0) {
    if (args[0] === "check-ref-format") throw new Error("Invalid Git branch name.");
    const operation = /^[a-z][a-z-]*$/.test(args[0]) ? args[0] : "operation";
    throw new Error(`Git ${operation} failed (exit ${result.code}). Check repository access and Git authentication. Diagnostics omitted to protect credentials.`);
  }
  return result.stdout.trim();
}

export async function validateBranch(exec: Exec, branch: string): Promise<void> {
  branchDirectory(branch);
  if (await git(exec, ["check-ref-format", "--branch", branch]) !== branch) {
    throw new Error("Enter a literal new branch name.");
  }
}

export async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Destination already exists: ${destination}`);
}

export function workspacePath(plan: WorkspacePlan): string {
  return join(plan.root, plan.name);
}

export async function validatePlan(plan: WorkspacePlan, exec: Exec): Promise<void> {
  validateName(plan.name);
  if (!isAbsolute(plan.root) || /[\x00-\x1f\x7f]/.test(plan.root)) throw new Error("Workspace root must be an absolute path without control characters.");
  if (!plan.purpose.trim() || /[\x00-\x1f\x7f]/.test(plan.purpose)) throw new Error("Enter a single-line workspace purpose.");
  if (plan.repositories.length === 0) throw new Error("Include at least one repository.");
  const names = new Set<string>();
  for (const repo of plan.repositories) {
    if (parseRepository(repo.source).source !== repo.source) throw new Error("Repository sources must be normalized before creation.");
    validateName(repo.name);
    if (names.has(repo.name.toLowerCase())) throw new Error(`Duplicate repository directory name: ${repo.name}`);
    names.add(repo.name.toLowerCase());
    if (typeof repo.referenceOnly !== "boolean") throw new Error("Repository access mode is required.");
    if (!repo.referenceOnly) {
      if (!repo.branch) throw new Error(`Feature branch required for ${repo.name}.`);
      await validateBranch(exec, repo.branch);
    } else if (repo.branch !== undefined) {
      throw new Error(`Reference-only repository ${repo.name} must not have a feature branch.`);
    }
  }
  await assertDestinationAvailable(workspacePath(plan));
}

export function previewPlan(plan: WorkspacePlan): string {
  const rows = plan.repositories.flatMap((repo) => [
    `${repo.source} → ${repo.name}-worktrees/main/ (main; read-only)`,
    repo.referenceOnly ? "  Reference only; no feature worktree" :
      `  New branch: ${repo.branch} from main → ${repo.name}-worktrees/${branchDirectory(repo.branch!)}/`,
  ]);
  return [
    `Create: ${workspacePath(plan)}`, `Purpose: ${plan.purpose}`, "", ...rows, "",
    "Generate: AGENTS.md, feature-plans/", "No feature work, dependency installation, or agent kickoff.",
    "Read-only is a workflow rule, not filesystem enforcement.",
  ].join("\n");
}

export function renderInstructions(plan: WorkspacePlan): string {
  const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("`", "\\`");
  const rows = plan.repositories.map((repo) => {
    const base = `${repo.name}-worktrees/main/`;
    const feature = repo.referenceOnly ? "—" : `${repo.name}-worktrees/${branchDirectory(repo.branch!)}/`;
    return `| ${cell(repo.name)} | ${cell(repo.source)} | ${base} | ${feature} | ${repo.referenceOnly ? "Reference only" : cell(repo.branch!)} |`;
  });
  return [
    `# ${plan.name}`, "", plan.purpose, "", "## Repositories", "",
    "| Repository | Source | Base checkout (read-only) | Feature worktree | Branch / access |",
    "| --- | --- | --- | --- | --- |", ...rows, "", "## Working rules", "",
    "- Develop only in the feature worktrees listed above.",
    "- Every main/ checkout is read-only: do not edit files or commit there.",
    "- Reference-only repositories are read-only throughout; do not create branches or worktrees in them.",
    "- Each repository has an independent clone; feature worktrees share only that clone's Git database.",
    "- Read and follow each repository's own AGENTS.md / CLAUDE.md before working there.",
    "- The workspace root is not a Git repository. Commit within the appropriate feature worktree.",
    "- feature-plans/ is available for future planning; setup has not started any feature work.",
    "- Read-only is a workflow rule, not an operating-system permission restriction.", "",
  ].join("\n");
}

function checkHeads(heads: string, repo: Repository): void {
  const branches = heads.split("\n").map((line) => line.split("\t")[1]).filter(Boolean);
  if (!branches.includes("refs/heads/main")) throw new Error(`${repo.name}: source has no main branch.`);
  if (!repo.referenceOnly) {
    const ref = `refs/heads/${repo.branch}`;
    if (branches.some((existing) => existing === ref || existing.startsWith(`${ref}/`) || ref.startsWith(`${existing}/`))) {
      throw new Error(`${repo.name}: branch ${repo.branch} already exists or conflicts with an existing branch; choose a new name.`);
    }
  }
}

export async function createWorkspace(plan: WorkspacePlan, exec: Exec, progress: (message: string) => void = () => {}): Promise<string> {
  await validatePlan(plan, exec);
  // Preflight all remotes before writing anything; cloning rechecks refs in case they change.
  for (const repo of plan.repositories) {
    progress(`Checking ${repo.name}…`);
    checkHeads(await git(exec, ["ls-remote", "--heads", "--", repo.source]), repo);
  }
  const destination = workspacePath(plan);
  await mkdir(plan.root, { recursive: true });
  await mkdir(destination); // Exclusive creation also catches races and dangling symlinks.
  const completed: string[] = [];
  let step = "writing workspace scaffolding";
  try {
    await writeFile(join(destination, "AGENTS.md"), renderInstructions(plan), { flag: "wx" });
    await mkdir(join(destination, "feature-plans"));
    for (const repo of plan.repositories) {
      step = `cloning ${repo.name}`;
      progress(`${step}…`);
      const container = join(destination, `${repo.name}-worktrees`);
      const base = join(container, "main");
      await mkdir(container);
      await git(exec, ["clone", "--no-local", "--origin", "origin", "--branch", "main", "--", repo.source, base]);
      completed.push(`${repo.name}: main clone`);
      const clonedHeads = await git(exec, ["for-each-ref", "--format=%(objectname)%09%(refname)", "refs/remotes/origin"], base);
      checkHeads(clonedHeads.replaceAll("refs/remotes/origin/", "refs/heads/"), repo);
      if (!repo.referenceOnly) {
        step = `creating ${repo.name} branch ${repo.branch}`;
        progress(`${step}…`);
        await git(exec, ["worktree", "add", "-b", repo.branch!, "--", join(container, branchDirectory(repo.branch!)), "refs/heads/main"], base);
        completed.push(`${repo.name}: ${repo.branch} worktree`);
      }
    }
    return destination;
  } catch (error) {
    throw new Error([
      `Workspace setup stopped while ${step}: ${(error as Error).message}`,
      `Partial workspace kept at ${destination}. Nothing was deleted.`,
      `Completed: ${completed.join("; ") || "no repositories"}.`,
      "AGENTS.md describes the intended layout; check the completed list before using it.",
    ].join("\n"), { cause: error });
  }
}

export async function discoverRepositories(root: string, exec: Exec): Promise<string[]> {
  const sources = new Set<string>();
  async function directories(path: string): Promise<string[]> {
    try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => join(path, entry.name)); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) return [];
      throw error;
    }
  }
  async function inspect(path: string): Promise<void> {
    try {
      if (!(await lstat(join(path, ".git"))).isDirectory()) return;
      const result = await exec("git", ["config", "--file", join(path, ".git", "config"), "--get", "remote.origin.url"], { timeout: 5000, maxBuffer: 8192 });
      if (result.code === 0 && result.stdout.trim()) {
        // Ignore unsupported or credential-bearing remotes rather than showing them in the picker.
        try { sources.add(parseRepository(result.stdout.trim()).source); } catch { /* Not a supported source. */ }
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    }
  }
  for (const workspace of await directories(root)) {
    await inspect(workspace);
    for (const candidate of await directories(workspace)) {
      if (basename(candidate).endsWith("-worktrees")) await inspect(join(candidate, "main"));
      else await inspect(candidate);
    }
  }
  return [...sources].sort();
}
