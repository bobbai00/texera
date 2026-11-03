/**
 * Keeps live agent instances by principal id. An instance is rebuilt when the person's
 * token changes (its MCP sessions carry that token) or when it has aged past the TTL.
 */
import type { Agent, CatalogAuth } from "../catalog/types.ts";
import type { AgentInstance, Spawner } from "./spawner.ts";

export interface AgentHostOptions {
  /** Milliseconds an instance stays cached; default ten minutes. */
  ttlMs?: number;
  now?: () => number;
}

export class AgentHost {
  private readonly instances = new Map<string, Promise<AgentInstance>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly spawner: Spawner,
    options: AgentHostOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the live instance for an agent, spawning or refreshing it as needed. */
  async acquire(pid: string, record: Agent, auth: CatalogAuth): Promise<AgentInstance> {
    const existing = this.instances.get(pid);
    if (existing) {
      const instance = await existing.catch(() => undefined);
      if (instance && instance.userToken === auth.userToken && this.now() - instance.createdAt < this.ttlMs) {
        return instance;
      }
      await this.evict(pid);
    }
    const spawning = this.spawner.spawn({ pid, record, auth });
    this.instances.set(pid, spawning);
    try {
      return await spawning;
    } catch (err) {
      this.instances.delete(pid);
      throw err;
    }
  }

  async evict(pid: string): Promise<void> {
    const existing = this.instances.get(pid);
    this.instances.delete(pid);
    if (!existing) return;
    const instance = await existing.catch(() => undefined);
    await instance?.close();
  }

  get size(): number {
    return this.instances.size;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((pid) => this.evict(pid)));
  }
}
