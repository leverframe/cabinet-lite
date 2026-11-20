export type Runtime = "openclaw" | "hermes" | "mcp";

export interface FeedEntry {
  ts: number;
  runtime: Runtime;
  agent: string;
  summary: string;
  ms: number;
  ok: boolean;
}

export class Feed {
  private entries: FeedEntry[] = [];

  constructor(private cap = 500) {}

  add(entry: Omit<FeedEntry, "ts"> & { ts?: number }) {
    const stamped: FeedEntry = { ts: Date.now(), ...entry };
    this.entries.unshift(stamped);
    if (this.entries.length > this.cap) this.entries.length = this.cap;
  }

  all(): FeedEntry[] {
    return [...this.entries];
  }
}
