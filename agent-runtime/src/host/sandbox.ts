/**
 * The sandbox interface: where an agent's commands run. The local provider runs them
 * as child processes of the runtime; a Kubernetes provider on sandbox nodes comes later.
 * Nothing calls this yet except its tests; it is the seam for code execution tools.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Milliseconds before the command is killed. */
  timeoutMs?: number;
}

export interface SandboxOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface SandboxRun {
  /** Output as it arrives. */
  output: AsyncIterable<SandboxOutputChunk>;
  /** Resolves with the exit code once the process ends. */
  exitCode: Promise<number>;
}

export interface Sandbox {
  readonly kind: string;
  run(command: string[], options?: RunOptions): SandboxRun;
  close(): Promise<void>;
}

/** Runs commands as child processes of the runtime. */
export class LocalSandbox implements Sandbox {
  readonly kind = "local";

  run(command: string[], options: RunOptions = {}): SandboxRun {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error("command is empty");
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: SandboxOutputChunk[] = [];
    let waiting: ((value: IteratorResult<SandboxOutputChunk>) => void) | undefined;
    let done = false;
    const push = (chunk: SandboxOutputChunk) => {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ value: chunk, done: false });
      } else {
        chunks.push(chunk);
      }
    };
    child.stdout.on("data", (d: Buffer) => push({ stream: "stdout", text: d.toString() }));
    child.stderr.on("data", (d: Buffer) => push({ stream: "stderr", text: d.toString() }));

    const exitCode = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        done = true;
        if (waiting) {
          const resolve2 = waiting;
          waiting = undefined;
          resolve2({ value: undefined as never, done: true });
        }
        resolve(code ?? -1);
      });
    });

    const kill = () => {
      if (!done) child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
    exitCode.finally(() => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    });

    const output: AsyncIterable<SandboxOutputChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SandboxOutputChunk>> {
            const queued = chunks.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    };
    return { output, exitCode };
  }

  async close(): Promise<void> {}
}
