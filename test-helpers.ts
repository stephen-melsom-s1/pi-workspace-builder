import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { git, type Exec } from "./workspace.ts";

const execute = promisify(execFile);
export const exec: Exec = async (command, args, options) => {
  try {
    const result = await execute(command, args, {
      ...options, encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
    });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout || "", stderr: failure.stderr || failure.message };
  }
};

export async function sourceRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(exec, ["init", "-b", "main", path]);
  await writeFile(join(path, "README.md"), "Fixture repository\n");
  await git(exec, ["add", "README.md"], path);
  await git(exec, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Initial"], path);
}
