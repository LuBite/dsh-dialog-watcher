/**
 * dsh-dialog-watcher — persistent store.
 *
 * Layout (under `DSH_HOME ?? ~/.dsh`, matching the convention documented in
 * the Phase 2 plan §4.7):
 *
 *   dialog-watcher/
 *     config.json       switches + thresholds (probe/click default ON)
 *     events/YYYYMMDD.jsonl   one JSON line per decision (FR6)
 *     bindings.json     programId -> sessionId (manual pinning, FR2.5)
 *
 * Paths are derived from DSH_HOME / homedir, never hardcoded (NFR4: the
 * workspace and user dirs contain non-ASCII characters).
 *
 * Every write is best-effort: a full disk or a locked file must degrade to
 * "no log" rather than take the host down (NFR1).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/** Resolve @deepseek-ai packages from the DSH profile when we run inside it. */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export const DEFAULT_CONFIG = {
  probeOn: true,
  clickOn: true,
  busyMs: 1500,
  idleMs: 5000,
  /** command intervals stay in the ledger this long after they end */
  ledgerRetentionMs: 10 * 60_000,
  /** pending medium-evidence dialog times out into the pool after this */
  mediumTimeoutMs: 10 * 60_000,
  /** strong-evidence window: [commandStart - beforeMs, commandEnd + afterMs] */
  timeWindowBeforeMs: 2_000,
  timeWindowAfterMs: 10_000,
  /** weak-evidence: only "time is close" counts when within this */
  weakWindowMs: 90_000,
  /** throttle: at most max notices per windowMs per session (rest merge) */
  throttleWindowMs: 60_000,
  throttleMax: 3,
  /** notify the session when an injected dialog disappears (FR3.6) */
  goneNotify: true,
  /** log windows with no attribution (normally dropped, NFR3) */
  debug: false,
  /** never-report exe basenames (extra to the probe's built-in deny list) */
  whitelist: [],
  /** minutes of silence from the UI (FR5.2, not persisted by the client) */
  muteUntilMs: 0,
};

export class Store {
  constructor(baseDir) {
    this.base = baseDir || join(dshHome(), "dialog-watcher");
    this.configPath = join(this.base, "config.json");
    this.bindingsPath = join(this.base, "bindings.json");
    this.eventsDir = join(this.base, "events");
  }

  ensureDirs() {
    try {
      if (!existsSync(this.eventsDir)) mkdirSync(this.eventsDir, { recursive: true });
    } catch {
      /* degrade to no-op logging */
    }
  }

  loadConfig() {
    const cfg = { ...DEFAULT_CONFIG };
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
      for (const k of Object.keys(cfg)) {
        if (raw[k] !== undefined) cfg[k] = raw[k];
      }
    } catch {
      /* first run: defaults */
    }
    return cfg;
  }

  saveConfig(patch) {
    const merged = { ...this.loadConfig(), ...patch };
    try {
      this.ensureDirs();
      writeFileSync(this.configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch {
      /* best effort */
    }
    return merged;
  }

  loadBindings() {
    try {
      const raw = JSON.parse(readFileSync(this.bindingsPath, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  saveBindings(bindings) {
    try {
      this.ensureDirs();
      writeFileSync(this.bindingsPath, JSON.stringify(bindings, null, 2) + "\n", "utf8");
    } catch {
      /* best effort */
    }
  }

  /** FR2.5: pin a program identity to a session; later dialogs go strong. */
  bind(programId, sessionId) {
    const bindings = this.loadBindings();
    bindings[programId] = { sessionId, at: Date.now() };
    this.saveBindings(bindings);
    return bindings;
  }

  unbind(programId) {
    const bindings = this.loadBindings();
    delete bindings[programId];
    this.saveBindings(bindings);
    return bindings;
  }

  /** FR6: append one decision record; day-partitioned, capped fields. */
  appendEvent(record) {
    try {
      this.ensureDirs();
      const day = new Date();
      const yyyy = day.getFullYear();
      const mm = String(day.getMonth() + 1).padStart(2, "0");
      const dd = String(day.getDate()).padStart(2, "0");
      const line =
        JSON.stringify({ ts: Date.now(), ...record }, (_k, v) => v) + "\n";
      appendFileSync(join(this.eventsDir, `${yyyy}${mm}${dd}.jsonl`), line, "utf8");
    } catch {
      /* logging must never break the watcher */
    }
  }
}

/**
 * Best-effort require of the DSH host packages. Plugins run inside the DSH
 * profile's node_modules tree, so bare imports of "@deepseek-ai/..." resolve
 * there; the require fallback keeps unit tests (plain `node test/cases.js`,
 * no DSH present) from crashing on import.
 */
export function tryRequire(id) {
  try {
    const req = createRequire(join(dshHome(), "profiles", "desktop", "noop.js"));
    return req(id);
  } catch {
    try {
      // Fall back to resolution from our own directory (dev checkouts).
      const req2 = createRequire(import.meta.url);
      return req2(id);
    } catch {
      return null;
    }
  }
}
