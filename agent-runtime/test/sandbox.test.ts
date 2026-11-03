import { describe, expect, test } from "bun:test";
import { LocalSandbox } from "../src/host/sandbox.ts";

describe("LocalSandbox", () => {
  test("streams output and resolves the exit code", async () => {
    const sandbox = new LocalSandbox();
    const run = sandbox.run(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);
    const chunks: string[] = [];
    for await (const chunk of run.output) chunks.push(`${chunk.stream}:${chunk.text.trim()}`);
    expect(await run.exitCode).toBe(3);
    expect(chunks.sort()).toEqual(["stderr:err", "stdout:out"]);
    await sandbox.close();
  });

  test("passes the working directory and environment", async () => {
    const run = new LocalSandbox().run(["sh", "-c", "echo $TEXERA_TEST; pwd"], {
      cwd: "/tmp",
      env: { TEXERA_TEST: "yes" },
    });
    let text = "";
    for await (const chunk of run.output) text += chunk.text;
    expect(await run.exitCode).toBe(0);
    expect(text).toContain("yes");
    expect(text).toMatch(/\/tmp|\/private\/tmp/);
  });

  test("kills the command on abort", async () => {
    const controller = new AbortController();
    const run = new LocalSandbox().run(["sleep", "30"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const code = await run.exitCode;
    expect(code).not.toBe(0);
  });

  test("kills the command on timeout", async () => {
    const run = new LocalSandbox().run(["sleep", "30"], { timeoutMs: 50 });
    expect(await run.exitCode).not.toBe(0);
  });
});
