import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exec, sourceRepository } from "./test-helpers.ts";
import {
  branchDirectory, createWorkspace, discoverRepositories, git, parseRepository,
  previewPlan, validateName, validatePlan, type Exec, type WorkspacePlan,
} from "./workspace.ts";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source repo");
  await sourceRepository(source);
  const plan: WorkspacePlan = {
    name: "experiment", purpose: "Test workspace", root: join(temporary, "work spaces"),
    repositories: [{ source, name: "app", referenceOnly: false, branch: "feature/new-search" }],
  };
  return { temporary, source, plan };
}

test("repository parsing accepts safe sources and rejects helpers and embedded credentials", () => {
  assert.deepEqual(parseRepository("org/app"), { source: "https://github.com/org/app.git", name: "app" });
  assert.equal(parseRepository("git@github.com:org/app.git").name, "app");
  assert.equal(parseRepository("ssh://git@github.com/org/app.git").name, "app");
  assert.equal(parseRepository("/tmp/source repo").name, "source-repo");
});

test("names and repository sources reject traversal, credentials, and unsafe transports", () => {
  for (const name of ["", ".", "..", "../escape", "a/b", "-option", "name\n", "x".repeat(101)]) {
    assert.throws(() => validateName(name));
  }
  for (const source of ["", "ext::sh -c exploit", "file:///tmp/repo", "https://token@github.com/org/app.git", "https://user:token@github.com/org/app.git", "ssh://user:token@host/app.git", "https://host/app?token=x", "https://host/app#token", "-repo", "org/app\nother", "git@-host:app.git"]) {
    assert.throws(() => parseRepository(source), source);
  }
  assert.equal(branchDirectory("feature/search"), "feature%2Fsearch");
  for (const branch of ["", "main", "MAIN", "@{-1}", "../escape", "-option"]) {
    if (branch === "../escape") continue; // Git's ref validation, tested below, rejects this.
    assert.throws(() => branchDirectory(branch));
  }
});

test("creates independent main clone and fresh feature worktree; source and main stay clean", async (t) => {
  const { source, plan } = await fixture(t);
  const refsBefore = await git(exec, ["show-ref"], source);
  const destination = await createWorkspace(plan, exec);
  const base = join(destination, "app-worktrees/main");
  const feature = join(destination, "app-worktrees/feature%2Fnew-search");
  assert.equal(await git(exec, ["branch", "--show-current"], base), "main");
  assert.equal(await git(exec, ["branch", "--show-current"], feature), "feature/new-search");
  assert.equal(await git(exec, ["rev-parse", "HEAD"], feature), await git(exec, ["rev-parse", "main"], base));
  assert.equal(await git(exec, ["status", "--porcelain"], base), "");
  assert.equal(await git(exec, ["status", "--porcelain"], feature), "");
  assert.equal(await git(exec, ["show-ref"], source), refsBefore);
  assert.equal(await git(exec, ["status", "--porcelain"], source), "");
  assert.ok((await lstat(join(base, ".git"))).isDirectory());
  assert.ok((await lstat(join(feature, ".git"))).isFile());
  assert.ok((await lstat(join(destination, "feature-plans"))).isDirectory());
  await assert.rejects(lstat(join(base, ".git/objects/info/alternates")), { code: "ENOENT" });
  await assert.rejects(lstat(join(destination, ".git")), { code: "ENOENT" });
  const instructions = await readFile(join(destination, "AGENTS.md"), "utf8");
  assert.match(instructions, /do not edit files or commit there/);
  assert.match(instructions, /feature%2Fnew-search/);
  const preview = previewPlan(plan);
  assert.match(preview, /New branch: feature\/new-search from main/);
  assert.match(preview, /No feature work/);
});

test("reference-only repos get main but no feature worktree", async (t) => {
  const { plan } = await fixture(t);
  plan.repositories[0] = { ...plan.repositories[0], referenceOnly: true, branch: undefined };
  const destination = await createWorkspace(plan, exec);
  assert.deepEqual(await readdir(join(destination, "app-worktrees")), ["main"]);
  assert.match(await readFile(join(destination, "AGENTS.md"), "utf8"), /Reference only/);
});

test("existing destinations, including dangling symlinks, are never overwritten", async (t) => {
  const { plan, temporary } = await fixture(t);
  await mkdir(plan.root, { recursive: true });
  const destination = join(plan.root, plan.name);
  await mkdir(destination);
  await writeFile(join(destination, "keep.txt"), "untouched");
  await assert.rejects(createWorkspace(plan, exec), /Destination already exists/);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "untouched");
  await rm(destination, { recursive: true });
  await symlink(join(temporary, "missing"), destination);
  await assert.rejects(createWorkspace(plan, exec), /Destination already exists/);
  assert.ok((await lstat(destination)).isSymbolicLink());
});

test("invalid branches, missing branches and duplicate names fail before writing", async (t) => {
  const { plan } = await fixture(t);
  for (const branch of ["main", "Main", "../escape", "feature..bad", "bad branch", "@{-1}", "HEAD"]) {
    plan.repositories[0].branch = branch;
    await assert.rejects(createWorkspace(plan, exec));
  }
  plan.repositories[0].branch = undefined;
  await assert.rejects(createWorkspace(plan, exec), /Feature branch required/);
  plan.repositories[0].branch = "new-feature";
  plan.repositories.push({ ...plan.repositories[0], name: "APP" });
  await assert.rejects(validatePlan(plan, exec), /Duplicate/);
  await assert.rejects(lstat(plan.root), { code: "ENOENT" });
});

test("preflight rejects existing or conflicting remote branches without creating workspace", async (t) => {
  const { source, plan } = await fixture(t);
  await git(exec, ["branch", "already-exists"], source);
  await git(exec, ["branch", "feature/older"], source);
  for (const branch of ["already-exists", "already-exists/child", "feature"]) {
    plan.repositories[0].branch = branch;
    await assert.rejects(createWorkspace(plan, exec), /already exists or conflicts/);
  }
  await assert.rejects(lstat(plan.root), { code: "ENOENT" });
});

test("missing main and inaccessible sources fail before writing", async (t) => {
  const { source, plan, temporary } = await fixture(t);
  await git(exec, ["branch", "-m", "main", "trunk"], source);
  await assert.rejects(createWorkspace(plan, exec), /no main branch/);
  plan.repositories[0].source = join(temporary, "missing");
  await assert.rejects(createWorkspace(plan, exec));
  await assert.rejects(lstat(plan.root), { code: "ENOENT" });
});

test("partial clone failures retain completed work and report exact progress", async (t) => {
  const { plan } = await fixture(t);
  plan.repositories.push({ ...plan.repositories[0], name: "second" });
  const failingExec: Exec = (command, args, options) => {
    if (args.includes("clone") && args.at(-1)?.includes("second-worktrees")) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "Simulated clone failure" });
    }
    return exec(command, args, options);
  };
  await assert.rejects(createWorkspace(plan, failingExec), (error: Error) => {
    assert.match(error.message, /cloning second/);
    assert.match(error.message, /app: feature\/new-search worktree/);
    assert.match(error.message, /Nothing was deleted/);
    return true;
  });
  assert.ok((await lstat(join(plan.root, plan.name, "app-worktrees/feature%2Fnew-search/.git"))).isFile());
});

test("branch arriving during clone is refused without reusing it", async (t) => {
  const { source, plan } = await fixture(t);
  const racingExec: Exec = async (command, args, options) => {
    if (args.includes("clone")) await git(exec, ["branch", plan.repositories[0].branch!], source);
    return exec(command, args, options);
  };
  await assert.rejects(createWorkspace(plan, racingExec), /already exists or conflicts/);
  await assert.rejects(lstat(join(plan.root, plan.name, "app-worktrees/feature%2Fnew-search")), { code: "ENOENT" });
});

test("discovers deduplicated remotes from plain and worktree layouts; ignores credential URLs", async (t) => {
  const { source, plan } = await fixture(t);
  await git(exec, ["remote", "add", "origin", "git@github.com:example/app.git"], source);
  await mkdir(plan.root);
  await mkdir(join(plan.root, "workspace"));
  await git(exec, ["clone", "--", source, join(plan.root, "workspace/plain")]);
  await git(exec, ["remote", "set-url", "origin", "git@github.com:example/app.git"], join(plan.root, "workspace/plain"));
  await mkdir(join(plan.root, "workspace/another-worktrees"));
  await git(exec, ["clone", "--", source, join(plan.root, "workspace/another-worktrees/main")]);
  await git(exec, ["remote", "set-url", "origin", "https://token@github.com/private/app.git"], join(plan.root, "workspace/another-worktrees/main"));
  assert.deepEqual(await discoverRepositories(plan.root, exec), ["git@github.com:example/app.git"]);
});

test("discovery merges GitHub URL spellings while preserving a clone URL and distinct repos", async (t) => {
  const { plan } = await fixture(t);
  const variants = [
    "git@github.com:example/infra", "git@github.com:example/infra.git",
    "ssh://git@github.com/example/infra", "ssh://git@github.com/example/infra.git",
    "https://github.com/example/infra", "https://github.com/example/infra.git",
    "https://github.com/EXAMPLE/Infra.git/", "git@GITHUB.COM:example/infra.git",
  ];
  const distinct = [
    "git@github.com:another-org/infra.git", "https://github.com/example/another-repo.git",
    "https://gitlab.com/example/infra.git", "/tmp/infra.git",
  ];
  for (const [index, source] of [...variants, ...distinct].entries()) {
    const metadata = join(plan.root, "workspace", `repo-${index}`, ".git");
    await mkdir(metadata, { recursive: true });
    await git(exec, ["config", "--file", join(metadata, "config"), "remote.origin.url", source]);
  }
  const discovered = await discoverRepositories(plan.root, exec);
  assert.equal(discovered.length, 1 + distinct.length);
  assert.equal(discovered.filter((source) => variants.includes(source)).length, 1);
  for (const source of distinct) assert.ok(discovered.includes(source), source);
});

test("clone explicitly uses origin despite clone.defaultRemoteName configuration", async (t) => {
  const { plan } = await fixture(t);
  const configuredExec: Exec = (command, args, options) => exec(command, ["-c", "clone.defaultRemoteName=upstream", ...args], options);
  const destination = await createWorkspace(plan, configuredExec);
  const base = join(destination, "app-worktrees/main");
  assert.equal(await git(exec, ["remote"], base), "origin");
  assert.equal(await git(exec, ["branch", "--show-current"], join(destination, "app-worktrees/feature%2Fnew-search")), "feature/new-search");
});

test("Git diagnostics never expose credentials from stderr or execution errors", async () => {
  const secret = "EXAMPLE_TOKEN";
  const credentialError = `fatal: unable to access https://user:${secret}@host/repo?token=${secret}\nAuthorization: Bearer ${secret}`;
  const failedExec: Exec = async () => ({ code: 1, stdout: "", stderr: credentialError });
  await assert.rejects(git(failedExec, ["ls-remote", "--heads", "https://host/repo"]), (error: Error) => {
    assert.match(error.message, /Git ls-remote failed/);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes("Authorization"));
    return true;
  });
  const throwingExec: Exec = async () => { throw new Error(credentialError); };
  await assert.rejects(git(throwingExec, ["clone", "https://host/repo"]), (error: Error) => !error.message.includes(secret));
});

test("worktree failure keeps completed work, reports the failed branch, and refuses overwrite on retry", async (t) => {
  const { plan } = await fixture(t);
  plan.repositories.push({ ...plan.repositories[0], name: "second" });
  const failingExec: Exec = async (command, args, options) => {
    if (args.includes("worktree") && options?.cwd?.includes("second-worktrees")) {
      await git(exec, ["branch", plan.repositories[1].branch!, "main"], options.cwd);
      await mkdir(args.at(-2)!); // Simulate a partially written checkout after branch creation.
      return { code: 1, stdout: "", stderr: "Checkout failed" };
    }
    return exec(command, args, options);
  };
  await assert.rejects(createWorkspace(plan, failingExec), (error: Error) => {
    assert.match(error.message, /creating second branch feature\/new-search/);
    assert.match(error.message, /app: feature\/new-search worktree/);
    assert.match(error.message, /Partial workspace kept at/);
    return true;
  });
  const destination = join(plan.root, plan.name);
  assert.equal(await git(exec, ["branch", "--show-current"], join(destination, "app-worktrees/feature%2Fnew-search")), "feature/new-search");
  assert.ok((await lstat(join(destination, "second-worktrees/feature%2Fnew-search"))).isDirectory());
  await assert.rejects(createWorkspace(plan, exec), /Destination already exists/);
});
