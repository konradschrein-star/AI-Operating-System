import Database from "better-sqlite3";

const DB_PATH = "/opt/hermes-control/control.db";

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

export interface Worker {
  id: string;
  role: string;
  worker_type: string;
  tmux_session: string;
  status: string;
  created_at: string;
  last_spawn: string | null;
  spawn_count: number;
}

export interface Heartbeat {
  id: number;
  worker_id: string;
  task_id: string | null;
  state: string;
  progress: string | null;
  failures: number;
  needs_human: number;
  activity_at: string;
  recorded_at: string;
}

export interface HermesEvent {
  id: number;
  event_type: string;
  worker_id: string | null;
  task_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface HermesTask {
  id: number;
  plane_id: string;
  worker_id: string | null;
  status: string;
  description: string | null;
  dispatch_at: string | null;
  completed_at: string | null;
  result: string | null;
  created_at: string;
}

export function listWorkers(): Worker[] {
  return db().prepare("SELECT * FROM workers ORDER BY id").all() as Worker[];
}

export function latestHeartbeatPerWorker(): Heartbeat[] {
  return db()
    .prepare(
      `
    SELECT h.* FROM heartbeats h
    INNER JOIN (
      SELECT worker_id, MAX(recorded_at) AS last
      FROM heartbeats
      GROUP BY worker_id
    ) m
    ON h.worker_id = m.worker_id AND h.recorded_at = m.last
    ORDER BY h.recorded_at DESC
  `,
    )
    .all() as Heartbeat[];
}

export function heartbeatsFor(workerId: string, limit = 50): Heartbeat[] {
  return db()
    .prepare(
      "SELECT * FROM heartbeats WHERE worker_id = ? ORDER BY recorded_at DESC LIMIT ?",
    )
    .all(workerId, limit) as Heartbeat[];
}

export function recentEvents(limit = 100): HermesEvent[] {
  return db()
    .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as HermesEvent[];
}

export function recentTasks(limit = 50): HermesTask[] {
  return db()
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit) as HermesTask[];
}
