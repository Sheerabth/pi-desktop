// Shared pi RPC client. KISS: one `pi-record` listener, id-correlated calls,
// per-cwd streaming subscribers. No state duplicated from pi.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Namespace: main window and quickbar must NEVER share a pi child, even
// for the same cwd. Otherwise one's newSession yanks the other's session
// mid-run and prompt routing becomes mystery soup. The backend keys
// children by (tag, cwd) and tags every event; this module filters by tag.
let NS = "main";
export function setTag(t: string): void {
  NS = t;
}

let seq = 0;
const pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
const subs = new Map<string, Set<(rec: any) => void>>();
let listening = false;

function subKey(cwd: string): string {
  return `${NS}\n${cwd}`;
}

export async function ensureListening(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen("pi-record", (e: any) => {
    const p = e.payload ?? {};
    const { cwd, tag, record } = p;
    if (tag !== NS) return;
    if (
      record &&
      record.type === "response" &&
      typeof record.id === "string" &&
      pending.has(record.id)
    ) {
      const h = pending.get(record.id)!;
      pending.delete(record.id);
      if (record.success) h.res(record.data);
      else h.rej(new Error(record.error ?? "pi error"));
      return;
    }
    const set = subs.get(subKey(cwd));
    if (set) set.forEach((fn) => fn(record));
  });
}

export function onRecord(cwd: string, fn: (rec: any) => void): () => void {
  const k = subKey(cwd);
  let set = subs.get(k);
  if (!set) {
    set = new Set();
    subs.set(k, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

async function call(cwd: string, obj: any, timeoutMs = 120_000): Promise<any> {
  await ensureListening();
  const id = `q${++seq}`;
  obj.id = id;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    invoke("pi_send", { cwd, payload: obj, tag: NS }).catch((err) => {
      pending.delete(id);
      rej(err);
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error("pi timeout"));
      }
    }, timeoutMs);
  });
}

export async function ensure(cwd: string): Promise<void> {
  await invoke("pi_ensure", { cwd, sessionDir: null, tag: NS });
}

export const pi = {
  prompt: (cwd: string, message: string, streamingBehavior?: "steer" | "followUp") =>
    call(cwd, {
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    }),
  abort: (cwd: string) => call(cwd, { type: "abort" }),
  newSession: (cwd: string) => call(cwd, { type: "new_session" }),
  switchSession: (cwd: string, sessionPath: string) =>
    call(cwd, { type: "switch_session", sessionPath }),
  state: (cwd: string) => call(cwd, { type: "get_state" }),
  messages: (cwd: string) => call(cwd, { type: "get_messages" }),
  models: (cwd: string) => call(cwd, { type: "get_available_models" }),
  setModel: (cwd: string, provider: string, modelId: string) =>
    call(cwd, { type: "set_model", provider, modelId }),
  thinkingLevels: (cwd: string) => call(cwd, { type: "get_available_thinking_levels" }),
  setThinking: (cwd: string, level: string) =>
    call(cwd, { type: "set_thinking_level", level }),
  setName: (cwd: string, name: string) =>
    call(cwd, { type: "set_session_name", name }),

  forkMessages: (cwd: string) => call(cwd, { type: "get_fork_messages" }),
  fork: (cwd: string, entryId: string) => call(cwd, { type: "fork", entryId }),
};

// new_session / switch_session / fork ACK immediately but switch
// asynchronously: poll get_state until the file actually changes, else
// the next prompt (and the transcript) still belong to the old session.
export async function awaitSession(cwd: string, before: string | null, want?: string, ms = 4000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const s: any = await pi.state(cwd);
      const f: string | null = s?.sessionFile ?? null;
      if (f && (want ? f === want : f !== before)) return f;
    } catch { /* pi busy/starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export interface SessionInfo {
  path: string;
  id: string;
  timestamp: string;
  cwd: string;
  name: string | null;
  preview: string | null;
}

export const sessions = {
  list: (cwd?: string): Promise<SessionInfo[]> =>
    invoke("list_sessions", { cwdFilter: cwd ?? null, sessionRoot: null }),
  del: (path: string): Promise<void> => invoke("delete_session", { path, sessionRoot: null }),
};

export interface AppConfig {
  quickbar_hotkey: string;
  main_hotkey: string;
  default_dir: string;
  recents: string[];
  last_cwd: string;
  run_in_bg?: boolean;
}

export const config = {
  get: (): Promise<AppConfig> => invoke("get_config"),
  set: (patch: Partial<AppConfig>): Promise<AppConfig> => invoke("set_config", { patch }),
};
