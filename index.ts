import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertDestinationAvailable, createWorkspace, discoverRepositories, expandPath,
  parseRepository, previewPlan, validateBranch, validateName, validatePlan,
  workspacePath, type Exec, type Repository, type WorkspacePlan,
} from "./workspace.ts";

type UI = Pick<ExtensionUIContext, "input" | "select" | "confirm" | "notify">;
class Cancelled extends Error {}

async function input(ui: UI, title: string, fallback = "", validate: (value: string) => void | Promise<void> = () => {}): Promise<string> {
  while (true) {
    const answer = await ui.input(title, fallback);
    if (answer === undefined) throw new Cancelled();
    const value = answer.trim() || fallback;
    try { await validate(value); return value; }
    catch (error) { ui.notify((error as Error).message, "warning"); }
  }
}

async function select(ui: UI, title: string, options: string[]): Promise<string> {
  const answer = await ui.select(title, options);
  if (answer === undefined) throw new Cancelled();
  return answer;
}

export async function collectPlan(ui: UI, exec: Exec, defaultRoot = join(homedir(), "Workspaces")): Promise<WorkspacePlan> {
  const name = await input(ui, "Workspace name", "", validateName);
  const purpose = await input(ui, "What is this workspace for?", "", (value) => {
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Enter a single-line workspace purpose.");
  });
  const root = expandPath(await input(ui, "Workspace parent directory (Enter uses the default)", defaultRoot, async (value) => {
    const path = expandPath(value);
    if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Paths cannot contain control characters.");
    await assertDestinationAvailable(join(path, name));
  }));
  const known = await discoverRepositories(root, exec);
  const repositories: Repository[] = [];
  while (true) {
    const choice = await select(ui, `Repositories (${repositories.length} selected)`, [
      "Enter a repository", ...(known.length ? ["Choose a known repository"] : []),
      ...(repositories.length ? ["Done adding repositories"] : []),
    ]);
    if (choice === "Done adding repositories") break;
    const source = choice === "Choose a known repository" ?
      await select(ui, "Known sources — a new independent clone will be created", known) :
      await input(ui, "Repository: owner/repo, HTTPS/SSH URL, or absolute local path", "", (value) => { parseRepository(value); });
    const parsed = parseRepository(source);
    const repoName = await input(ui, "Repository directory name (Enter uses the default)", parsed.name, (value) => {
      validateName(value);
      if (repositories.some((repo) => repo.name.toLowerCase() === value.toLowerCase())) throw new Error("That directory name is already selected. Choose a unique name.");
    });
    const mode = await select(ui, `${repoName}: repository access`, ["Develop on a new feature branch", "Reference only (read-only)"]);
    repositories.push({ source: parsed.source, name: repoName, referenceOnly: mode === "Reference only (read-only)" });
  }
  const writable = repositories.filter((repo) => !repo.referenceOnly);
  if (writable.length) {
    const shared = await input(ui, "New feature-branch name (Enter uses the workspace name)", name, (value) => validateBranch(exec, value));
    const overrides = writable.length > 1 && await select(ui, "Feature branch names", [
      `Use ${shared} in every writable repository`, "Set per-repository overrides",
    ]) === "Set per-repository overrides";
    for (const repo of writable) {
      repo.branch = overrides ? await input(ui, `New branch for ${repo.name} (Enter uses ${shared})`, shared, (value) => validateBranch(exec, value)) : shared;
    }
  }
  const plan = { name, purpose, root, repositories };
  await validatePlan(plan, exec);
  return plan;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default function workspaceBuilder(pi: ExtensionAPI) {
  let busy = false;
  pi.registerCommand("workspace", {
    description: "Create a workspace with independent clones and new feature-branch worktrees: /workspace create",
    getArgumentCompletions: (prefix) => "create".startsWith(prefix) ? [{ value: "create", label: "create" }] : null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/workspace create needs interactive Pi or a dialog-capable RPC client.");
      if (args.trim() !== "create") { ctx.ui.notify("Usage: /workspace create", "info"); return; }
      if (busy || !ctx.isIdle()) { ctx.ui.notify("Wait for the current operation to finish before creating a workspace.", "warning"); return; }
      busy = true;
      try {
        const exec: Exec = (command, args, options) => pi.exec(command, args, options);
        const plan = await collectPlan(ctx.ui, exec);
        if (!await ctx.ui.confirm("Create this workspace?", previewPlan(plan))) throw new Cancelled();
        await createWorkspace(plan, exec, (message) => ctx.ui.setStatus("workspace-builder", message));
        ctx.ui.notify(`Workspace ready: ${workspacePath(plan)}\nStart Pi with: cd ${shellQuote(workspacePath(plan))} && pi\nSetup only; no feature work was started.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Cancelled ? "Workspace creation cancelled. No files were created." : (error as Error).message,
          error instanceof Cancelled ? "info" : "error");
      } finally {
        busy = false;
        ctx.ui.setStatus("workspace-builder", undefined);
      }
    },
  });
}
