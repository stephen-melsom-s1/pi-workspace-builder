import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exec, sourceRepository } from "./test-helpers.ts";
import { git } from "./workspace.ts";

for (const globalInstall of [false, true]) {
test(`Pi loads the ${globalInstall ? "globally discovered" : "explicit"} extension and completes native RPC setup without a model turn`, { timeout: 30_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-rpc-"));
  const source = join(temporary, "app");
  const root = join(temporary, "workspaces");
  await sourceRepository(source);
  const config = join(temporary, "pi-config");
  if (globalInstall) {
    await mkdir(join(config, "extensions"), { recursive: true });
    await symlink(fileURLToPath(new URL(".", import.meta.url)), join(config, "extensions/pi-workspace-builder"));
  }
  const child = spawn("pi", [
    "--mode", "rpc", "--no-session", "--offline", "--no-mcp",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    ...(globalInstall ? [] : ["--no-extensions", "-e", fileURLToPath(new URL("./index.ts", import.meta.url))]),
  ], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(temporary, { recursive: true, force: true });
  });
  const inputs = ["rpc-search", "RPC setup smoke test", root, source, "", "feature/rpc-search"];
  const choices = ["Enter a repository", "Develop on a new feature branch", "Done adding repositories"];
  let ready = false;
  let previewed = false;
  let handled = false;
  let stderr = "";
  const send = (record: object) => child.stdin.write(`${JSON.stringify(record)}\n`);
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && ready && handled) resolve();
      else reject(new Error(`Pi smoke test failed (exit ${code}): ${stderr}`));
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          assert.notEqual(record.type, "agent_start", "Workspace setup must not start a model turn");
          if (record.type === "response" && record.command === "get_commands") {
            assert.equal(record.success, true);
            assert.ok(record.data.commands.some((command: { name: string }) => command.name === "workspace"));
            send({ id: "create", type: "prompt", message: "/workspace create" });
          } else if (record.type === "extension_ui_request") {
            if (record.method === "input") {
              assert.ok(inputs.length, `Unexpected input: ${record.title}`);
              send({ type: "extension_ui_response", id: record.id, value: inputs.shift() });
            } else if (record.method === "select") {
              const value = choices.shift();
              assert.ok(record.options.includes(value), `Unexpected selection: ${record.title}`);
              send({ type: "extension_ui_response", id: record.id, value });
            } else if (record.method === "confirm") {
              assert.match(record.message, /New branch: feature\/rpc-search from main/);
              previewed = true;
              send({ type: "extension_ui_response", id: record.id, confirmed: true });
            } else if (record.method === "notify") {
              assert.notEqual(record.notifyType, "error", record.message);
              if (record.message.startsWith("Workspace ready:")) ready = true;
            }
          } else if (record.type === "response" && record.id === "create") {
            assert.equal(record.success, true);
            assert.equal(record.data.disposition, "handled");
            handled = true;
            child.stdin.end();
          }
        } catch (error) {
          child.kill("SIGKILL");
          reject(error);
        }
      }
    });
    send({ id: "commands", type: "get_commands" });
  });
  assert.ok(previewed);
  assert.equal(inputs.length, 0);
  assert.equal(choices.length, 0);
  const feature = join(root, "rpc-search/app-worktrees/feature%2Frpc-search");
  assert.ok((await lstat(join(feature, ".git"))).isFile());
  assert.equal(await git(exec, ["branch", "--show-current"], feature), "feature/rpc-search");
});
}
