import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LockInfo, LockResult, SessionStatus, TurnRecord } from "./types.js";

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_HC_HOME;
  if (configured && configured.trim()) return configured;
  return join(homedir(), ".claude-hc");
}

/** True when a signal-0 probe succeeds or is refused with EPERM (alive, other user). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TURN_FILE = /^turn-\d{4}\.json$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeAtomically(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export class SessionStore {
  constructor(readonly home: string) {}

  sessionDir(id: string): string {
    return join(this.home, "sessions", id);
  }

  ensureSessionDir(id: string): string {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  nextTurnNumber(id: string): number {
    const dir = this.sessionDir(id);
    if (!existsSync(dir)) return 1;
    return readdirSync(dir).filter((name) => TURN_FILE.test(name)).length + 1;
  }

  turnFilePath(id: string, turn: number): string {
    return join(this.sessionDir(id), `turn-${String(turn).padStart(4, "0")}.json`);
  }

  /** Write turn-NNNN.json and latest.json atomically; returns the turn file path. */
  writeTurnResult(id: string, turn: number, record: TurnRecord): string {
    this.ensureSessionDir(id);
    const file = this.turnFilePath(id, turn);
    const content = JSON.stringify({ ...record, result_file: file }, null, 2) + "\n";
    writeAtomically(file, content);
    writeAtomically(join(this.sessionDir(id), "latest.json"), content);
    return file;
  }

  readLatest(id: string): TurnRecord | null {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(id), "latest.json"), "utf8")) as TurnRecord;
    } catch {
      return null;
    }
  }

  lockPath(id: string): string {
    return join(this.sessionDir(id), "lock");
  }

  readLock(id: string): LockInfo | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath(id), "utf8")) as Partial<LockInfo>;
      if (typeof parsed.pid !== "number") return null;
      return {
        pid: parsed.pid,
        started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
        turn: typeof parsed.turn === "number" ? parsed.turn : 0,
      };
    } catch {
      return null;
    }
  }

  /** Exclusive create; a stale (dead pid) or malformed lock is replaced. */
  acquireLock(id: string, turn: number): LockResult {
    this.ensureSessionDir(id);
    const path = this.lockPath(id);
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), turn });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, payload);
        closeSync(fd);
        return { acquired: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const existing = this.readLock(id);
      if (existing && isPidAlive(existing.pid)) {
        return { acquired: false, pid: existing.pid, started_at: existing.started_at };
      }
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it first; the next create attempt decides.
      }
    }
    const last = this.readLock(id);
    return { acquired: false, pid: last?.pid ?? -1, started_at: last?.started_at ?? "" };
  }

  /** Remove the lock only when this process owns it. */
  releaseLock(id: string): void {
    const lock = this.readLock(id);
    if (lock && lock.pid === process.pid) {
      try {
        unlinkSync(this.lockPath(id));
      } catch {
        // Already gone.
      }
    }
  }

  status(id: string): SessionStatus {
    const lock = this.readLock(id);
    let inFlight = false;
    let pid: number | null = null;
    let startedAt: string | null = null;
    if (lock) {
      if (isPidAlive(lock.pid)) {
        inFlight = true;
        pid = lock.pid;
        startedAt = lock.started_at;
      } else {
        try {
          unlinkSync(this.lockPath(id));
        } catch {
          // Already gone.
        }
      }
    } else if (existsSync(this.lockPath(id))) {
      // Malformed lock file: treat as stale.
      try {
        unlinkSync(this.lockPath(id));
      } catch {
        // Already gone.
      }
    }
    return {
      claude_hc: 1,
      session_id: id,
      session_dir: this.sessionDir(id),
      in_flight: inFlight,
      pid,
      lock_started_at: startedAt,
      last: this.readLatest(id),
    };
  }

  async waitForRelease(id: string, timeoutMs: number, pollMs: number = 1000): Promise<SessionStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.status(id);
      if (!current.in_flight) return current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return current;
      await sleep(Math.min(pollMs, remaining));
    }
  }
}
