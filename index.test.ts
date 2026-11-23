import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import workspaceBuilder, { collectPlan, shellQuote } from "./index.ts";
import { exec, sourceRepository } from "./test-helpers.ts";

type UI = Parameters<typeof collectPlan>[0];
function scriptedUI(inputs: (string | undefined)[], selections: (string | undefined)[], confirmed = true) {
  const notifications: string[] = [];
  const questions: string[] = [];
  const ui: UI = {
    input: async (title) => { questions.push(title); assert.ok(inputs.length, `Unexpected input: ${title}`); return inputs.shift(); },
    select: async (title, options) => {
      questions.push(title);
      assert.ok(selections.length, `Unexpected select: ${title}`);
      const value = selections.shift();
      if (value !== undefined) assert.ok(options.includes(value), `Unavailable selection: ${value}`);
      return value;
    },
    confirm: async () => confirmed,
    notify: (message) => { notifications.push(message); },
  };
  return { ui, notifications, questions };
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-wizard-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "app");
  await sourceRepository(source);
  return { temporary, source, root: join(temporary, "workspaces") };
}

function command(ui: UI, run = exec) {
  let registered: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  workspaceBuilder({
    registerCommand: (name, definition) => { assert.equal(name, "workspace"); registered = definition; },
    exec: run,
  } as ExtensionAPI);
  assert.ok(registered);
  const ctx = { hasUI: true, isIdle: () => true, ui: { ...ui, setStatus: () => {} } } as unknown as ExtensionCommandContext;
  return { registered, ctx };
}

const enter = "Enter a repository";
const develop = "Develop on a new feature branch";
const reference = "Reference only (read-only)";
const done = "Done adding repositories";

test("wizard gathers a new branch without an existing-branch question or any writes", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, questions } = scriptedUI(["search", "Try a new search approach", root, source, "", ""], [enter, develop, done]);
  const plan = await collectPlan(ui, exec);
  assert.deepEqual(plan.repositories, [{ source, name: "app", referenceOnly: false, branch: "search" }]);
  assert.ok(questions.every((question) => !/existing branch|base branch/i.test(question)));
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("all-reference workspace skips feature-branch questions", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, questions } = scriptedUI(["reference", "Read-only research", root, source, ""], [enter, reference, done]);
  const plan = await collectPlan(ui, exec);
  assert.equal(plan.repositories[0].referenceOnly, true);
  assert.equal(plan.repositories[0].branch, undefined);
  assert.ok(questions.every((question) => !question.includes("feature-branch name")));
});

test("per-repo overrides and duplicate alias retry", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, notifications } = scriptedUI(
    ["search", "Search project", root, source, "", source, "", "backend", "feature/shared", "feature/app", ""],
    [enter, develop, enter, develop, done, "Set per-repository overrides"],
  );
  const plan = await collectPlan(ui, exec);
  assert.equal(plan.repositories[0].branch, "feature/app");
  assert.equal(plan.repositories[1].branch, "feature/shared");
  assert.match(notifications[0], /already selected/);
});

test("invalid workspace name and branch are re-prompted", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, notifications } = scriptedUI(
    ["../escape", "search", "Purpose", root, source, "", "main", "feature..bad", "new-search"],
    [enter, develop, done],
  );
  const plan = await collectPlan(ui, exec);
  assert.equal(plan.name, "search");
  assert.equal(plan.repositories[0].branch, "new-search");
  assert.equal(notifications.length, 3);
});

test("cancelling any wizard dialog leaves no workspace", async (t) => {
  const { source, root } = await fixture(t);
  const inputs: (string | undefined)[] = ["search", "Purpose", root, source, "", "new-search"];
  const selections = [enter, develop, done];
  for (let i = 0; i < inputs.length; i++) {
    const cancelled = [...inputs]; cancelled[i] = undefined;
    await assert.rejects(collectPlan(scriptedUI(cancelled, [...selections]).ui, exec));
  }
  for (let i = 0; i < selections.length; i++) {
    const cancelled: (string | undefined)[] = [...selections]; cancelled[i] = undefined;
    await assert.rejects(collectPlan(scriptedUI([...inputs], cancelled).ui, exec));
  }
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("command confirmation cancellation does not write files or start a model turn", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, notifications } = scriptedUI(["search", "Purpose", root, source, "", "new-search"], [enter, develop, done], false);
  const { registered, ctx } = command(ui);
  await registered.handler("create", ctx);
  assert.match(notifications.at(-1)!, /cancelled. No files were created/);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("command creates workspace and stops after setup", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, notifications } = scriptedUI(["search", "Purpose", root, source, "", "new-search"], [enter, develop, done]);
  const { registered, ctx } = command(ui);
  await registered.handler("create", ctx);
  assert.match(notifications.at(-1)!, /Workspace ready:/);
  assert.match(notifications.at(-1)!, /Setup only; no feature work was started/);
  assert.ok((await lstat(join(root, "search/app-worktrees/new-search/.git"))).isFile());
});

test("credential-bearing Git diagnostics do not reach notifications", async (t) => {
  const { source, root } = await fixture(t);
  const { ui, notifications } = scriptedUI(["search", "Purpose", root, source, "", "new-search"], [enter, develop, done]);
  const { registered, ctx } = command(ui, (command, args, options) => args.includes("ls-remote") ?
    Promise.resolve({ code: 1, stdout: "", stderr: "https://user:EXAMPLE_TOKEN@host/repo?token=EXAMPLE_TOKEN" }) : exec(command, args, options));
  await registered.handler("create", ctx);
  assert.match(notifications.at(-1)!, /Git ls-remote failed/);
  assert.ok(notifications.every((message) => !message.includes("EXAMPLE_TOKEN")));
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("command guards noninteractive mode and handles usage", async () => {
  const { ui, notifications } = scriptedUI([], []);
  const { registered, ctx } = command(ui);
  await registered.handler("help", ctx);
  assert.deepEqual(notifications, ["Usage: /workspace create"]);
  await assert.rejects(registered.handler("create", { ...ctx, hasUI: false }), /needs interactive Pi/);
});

test("launch command escapes paths containing shell quotes", () => {
  assert.equal(shellQuote("/tmp/a'b"), "'/tmp/a'\\''b'");
});

test("unreadable discovery candidates do not prevent manual repository entry", async (t) => {
  if (process.getuid?.() === 0) { t.skip("Root bypasses filesystem permissions"); return; }
  const { source, root } = await fixture(t);
  const inaccessible = join(root, "inaccessible");
  await mkdir(inaccessible, { recursive: true });
  await chmod(inaccessible, 0);
  try {
    const { ui } = scriptedUI(["search", "Purpose", root, source, "", "new-search"], [enter, develop, done]);
    const plan = await collectPlan(ui, exec);
    assert.equal(plan.repositories[0].source, source);
    await assert.rejects(lstat(join(root, "search")), { code: "ENOENT" });
  } finally {
    await chmod(inaccessible, 0o700);
  }
});
