/**
 * dsh-dialog-watcher — session command ledger (Phase2 方案 §4.2).
 *
 * Per session we keep the window of every command execution:
 *
 *   ledger[sessionId] = [{
 *     command,        // job.label (the full shell line)
 *     callId,         // tool-call id when it could be correlated (retry chains)
 *     startMs, endMs, // execution window (endMs null while running)
 *     exeHints,       // exe/msi/... names + paths + basenames extracted from command
 *   }]
 *
 * Data sources (all confirmed against a live session.v4.jsonl):
 *   job/registered  data:{jobId, owner=sessionId, kind, label, startedAt}
 *   job/settled     data:{..., startedAt, finishedAt, status}
 *   assistant/message content[] blocks {type:'tool-call', id:'call_..', name, arguments}
 *
 * The tool-call id lets the attributor's mutex (c) reject retry chains: a
 * model retrying the same tool call re-emits the same id, so two intervals
 * sharing a callId are ONE logical execution, never C1+C2.
 *
 * Toolhelp32 is NOT used anywhere (hard constraint 6: the snapshot is
 * sandbox-trimmed and useless); the ledger is built purely from session
 * events, and window->session attribution stays on the attributor side.
 */

// Bare-name branch requires the token to START here: a lookbehind keeps
// shell noise from fusing onto the name ("2>npowershell.exe" must not yield
// "npowershell.exe" — second-acceptance 2.3). `.ps1` is deliberately NOT a
// hint (third acceptance 2.4): a ps1 name in a command means "the command
// mentions a script", never "the dialog process IS that script" — a window
// process is always the interpreter, so a ps1 hint could only misfire.
const EXE_HINT_RE = /([A-Za-z]:\\[^\s"'|<>]+?\.(?:exe|com|msi|msix|bat|cmd))|((?<![\w.\-])[A-Za-z0-9][\w.\-]*\.(?:exe|com|msi|msix|bat|cmd))/gi;

/**
 * Interpreters invoked WITHOUT an extension ("powershell -NoProfile ...",
 * "node server.js", "python main.py") carry no ".exe" token, so an
 * extension-only regex cannot see them. Only the FIRST token of each command
 * segment is considered - that keeps "echo node" from minting a "node" hint
 * while "node server.js" still works, and no fixed launcher list is needed.
 *
 */
const KNOWN_LAUNCHERS = new Set([
  "powershell", "pwsh", "cmd", "bash", "sh", "zsh",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "python", "python3", "py", "pip", "pip3", "poetry", "uv", "conda",
  "java", "javaw", "dotnet", "ruby", "perl", "php", "rscript", "go", "cargo",
  "git", "msiexec", "wscript", "cscript", "mshta", "regsvr32", "rundll32",
  "schtasks", "curl", "wget", "winget", "choco", "scoop", "tar", "ffmpeg",
]);

/** First-token launcher hints, one per command segment. */
function launcherHints(text) {
  const found = new Set();
  if (!text) return found;
  for (const rawSeg of String(text).split(/[;&|\r\n]+/)) {
    let seg = rawSeg.trim().replace(/^[(\s]+/, "");
    if (!seg) continue;
    let tok = seg.split(/\s+/)[0] || "";
    tok = tok.replace(/^["']/, "").replace(/["']$/, "");
    if (!tok) continue;
    const base = baseName(tok).toLowerCase().replace(/\.(exe|com|bat|cmd)$/, "");
    if (KNOWN_LAUNCHERS.has(base)) found.add(base + ".exe");
  }
  return found;
}

export function extractExeHints(commandText) {
  if (!commandText) return [];
  // No pre-processing. Replacing literal backslash-n/r/t pairs with a space
  // would eat real Windows path separators - "D:\nodejs\node.exe" would
  // become " ode.exe" and mint the hint "ode.exe". Multi-line text needs no
  // pre-processing either: the hint regex never crosses a newline. Payloads
  // that fail JSON decode must be passed as "" by the caller (see
  // commandTextOfToolCall).
  const text = String(commandText);
  const hints = new Set();
  let m;
  const re = new RegExp(EXE_HINT_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    const full = m[1];
    const bare = m[2];
    if (full) {
      hints.add(full.toLowerCase());
      hints.add(baseName(full).toLowerCase());
    } else if (bare) {
      hints.add(bare.toLowerCase());
    }
  }
  for (const n of launcherHints(text)) hints.add(n);
  return [...hints];
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Timestamp that honours 0 (epoch-relative test clocks) but not junk. */
function tsOf(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** One human-meaningful line out of a script body (second-acceptance 2.3). */
function summarizeScript(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const exeRe = /[\w.\-]+\.(?:exe|com|msi|msix|bat|cmd)\b/i;
  const shellRe = /\b(powershell|pwsh|cmd|bash|python|node|npm|npx|pip|git|msiexec|wscript|cscript|mshta|msbuild|dotnet|start)\b/i;
  // Third acceptance 2.1: a line like `file_path: wd + "/x/dlg7.ps1",` is an
  // ARGUMENT assignment, not a command — leading `key:`/`key =` form. Never
  // pick one of those as the command summary.
  const kvLine = /^[A-Za-z_$"'][\w.$"']*\s*[:=]\s*/;
  const candidates = lines.filter((l) => !kvLine.test(l));
  const pool = candidates.length > 0 ? candidates : lines;
  // 1st choice: a line that STARTS with an executable or a shell name
  // (`powershell.exe -NoProfile -File …`, `mshta …`).
  const exeStart = /^[A-Za-z][\w.\-]*\.(?:exe|com|bat|cmd|msi)\b/i;
  const shellStart = /^(?:powershell|pwsh|cmd|python|node|wscript|cscript|mshta|msiexec|npm|npx|pip|git|bash|start|msbuild|dotnet)\b/i;
  for (const line of pool) if (exeStart.test(line) || shellStart.test(line)) return truncateLine(line);
  // 2nd: a plain line that invokes an executable anywhere in it.
  for (const line of pool) if (exeRe.test(line)) return truncateLine(line);
  // 3rd: any line mentioning a shell.
  for (const line of pool) if (shellRe.test(line)) return truncateLine(line);
  return truncateLine(pool[0]);
}

function truncateLine(line) {
  return line.length > 160 ? line.slice(0, 160) + "…" : line;
}

/**
 * Pull the command out of a tool-call block. Returns { text, full }:
 * `text` is the human-readable summary that goes into the ledger's command
 * field (and the injected evidence), `full` is everything hints should be
 * extracted from (a summary line alone would miss executables started on
 * other lines of the script).
 */
/**
 * Tools whose payload IS a shell command. Only these may seed exe hints;
 * everything else (run_code source, arbitrary argument JSON) is scaffolding
 * and must never be treated as a command. Matching is on the tool NAME plus
 * the presence of a `command` argument, so an unknown-but-command-carrying
 * tool still works - the payload decides, not a fixed list of names.
 */
const EXEC_TOOL_NAMES = new Set([
  "bash", "ops_bash", "pwsh", "powershell", "cmd", "shell", "exec",
  "terminal", "bash_persistent", "pwsh_persistent", "run_shell",
]);

function commandTextOfToolCall(block) {
  let args = block.arguments;
  const toolName = typeof block?.name === "string" && block.name ? block.name : "tool";
  // DSH ships tool-call arguments as a JSON STRING (confirmed against a live
  // session log); parse it first or the whole `{"code": ...}` blob ends up
  // as the "command" — which is exactly what the second acceptance saw in
  // the injected evidence.
  if (typeof args === "string") {
    let parsed = null;
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") return commandTextOfToolCall({ name: toolName, arguments: parsed });
    // A bare string is either a real command (execution tools pass one) or an
    // unparseable blob. Only execution tools may seed hints from it; for the
    // rest keep a label but mint nothing.
    if (EXEC_TOOL_NAMES.has(toolName.toLowerCase())) return { text: args, full: args };
    return { text: `[${toolName}] <unparseable payload>`, full: "" };
  }
  if (args && typeof args === "object") {
    if (typeof args.command === "string" && args.command.trim()) {
      return { text: args.command, full: args.command };
    }
    // ONLY an execution tool's `command` may seed exe hints. run_code's
    // `code` is a TypeScript source blob and every other tool's argument JSON
    // is scaffolding - hinting from either would mint false positives (a code
    // COMMENT mentioning "powershell.exe" would earn a strong verdict) and
    // unreadable evidence. The interval is still created so timing stays
    // honest; only `full` (the hint source) is emptied.
    const label = typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : typeof args.script === "string" && args.script.trim()
        ? summarizeScript(args.script)
        : summarizeScript(typeof args.code === "string" ? args.code : JSON.stringify(args));
    return { text: `[${toolName}] ${label}`.slice(0, 400), full: "" };
  }
  return { text: "", full: "" };
}

export class Ledger {
  constructor(config) {
    this.config = config || {};
    /** @type {Map<string, Array>} sessionId -> intervals (newest last) */
    this.sessions = new Map();
    /** sessionId -> [{id, at, command}] recent tool-call ids awaiting a job */
    this.pendingCalls = new Map();
  }

  /** Close the tool-call interval that `tool/result` reports done. */
  endToolCall(session, event) {
    const data = event?.data;
    if (!data) return;
    const callId = data?.source?.callId || data?.message?.toolCallId;
    if (!callId) return;
    const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now();
    const sid = this.sessionIdFrom({}, session);
    const lists = sid ? [this.list(sid)] : [...this.sessions.values()];
    for (const list of lists) {
      for (const iv of list) {
        if (iv.callId === callId && iv.endMs === null) iv.endMs = Math.max(at, iv.startMs);
      }
    }
  }

  /** Called by the host for every session/event. Never throws. */
  onSessionEvent(session, event) {
    try {
      const type = event?.type;
      const data = event?.data;
      if (!type || !data) return;
      if (type === "job/registered") this.begin(data);
      else if (type === "job/settled") this.end(data);
      else if (type === "assistant/message") this.noteToolCalls(session, event);
      // job/settled closes the subprocess intervals, but in-process tools have
      // no job at all - without a real end their interval stays open forever
      // and covers every later instant (a user-save dialog then matches two
      // sessions and "recently active" is always true). tool/result is the
      // real end.
      else if (type === "tool/result") this.endToolCall(session, event);
    } catch {
      /* the ledger must never break the host */
    }
  }

  sessionIdFrom(data, session) {
    const owner = data?.owner;
    if (typeof owner === "string" && owner) return owner.replace(/^session-/, "");
    if (session?.id) return String(session.id).replace(/^session-/, "");
    return null;
  }

  begin(data) {
    if (!data) return;
    const sid = this.sessionIdFrom(data, null);
    if (!sid) return;
    const list = this.list(sid);
    // One interval per jobId.
    if (list.some((iv) => iv.jobId === data.jobId)) return;
    // Preferred: attach the job to a ledgered tool-call interval (same
    // callId) — the tool-call text is the richer, first-hand command.
    const callId = this.correlateCallId(sid, data);
    if (callId) {
      const iv = list.find((x) => x.callId === callId);
      if (iv) {
        iv.jobId = data.jobId;
        const started = tsOf(data.startedAt, iv.startMs);
        if (data.startedAt !== undefined) iv.startMs = Math.min(iv.startMs, started);
        return;
      }
    }
    // Fallback: ledger the job by its own label (first-acceptance P2-1 showed
    // this path cannot be the only one — the tool-call text and the job label
    // do not always travel together).
    if (typeof data.label !== "string") return;
    list.push({
      jobId: data.jobId,
      callId: callId,
      command: data.label,
      exeHints: extractExeHints(data.label),
      startMs: tsOf(data.startedAt, Date.now()),
      endMs: null,
    });
    if (list.length > 200) list.splice(0, list.length - 200);
  }

  end(data) {
    if (!data) return;
    const sid = this.sessionIdFrom(data, null);
    if (!sid) return;
    const list = this.list(sid);
    let iv = list.find((x) => x.jobId === data.jobId);
    if (!iv && typeof data.label === "string") {
      // tool-call-ledgered interval the job never got attached to: match it
      // by the identical command text while it is still open.
      iv = list.find((x) => x.jobId === null && x.endMs === null && x.command === data.label);
    }
    if (!iv) {
      // Registered was missed entirely; reconstruct from the settled payload.
      list.push({
        jobId: data.jobId,
        callId: null,
        command: typeof data.label === "string" ? data.label : "",
        exeHints: extractExeHints(typeof data.label === "string" ? data.label : ""),
        startMs: tsOf(data.startedAt, Date.now()),
        endMs: tsOf(data.finishedAt, Date.now()),
      });
      return;
    }
    iv.endMs = tsOf(data.finishedAt, Date.now());
    if (!iv.command && typeof data.label === "string") {
      iv.command = data.label;
      iv.exeHints = extractExeHints(data.label);
    }
  }

  /**
   * Ledger tool-calls DIRECTLY (first-acceptance P2-1 fix).
   *
   * The tool-call block carries { id, name, arguments } — the arguments text
   * is the first-hand command and needs no job event to be useful. Relying on
   * job/registered alone left the runtime ledger with intervals whose
   * exeHints were empty whenever the label path failed, demoting obvious
   * strong evidence (H1) to medium. Non-command calls (file edits, searches)
   * ledger too: their windows only feed the MEDIUM channel (which never
   * injects without a full two-command/two-dialog pairing), and the retention
   * sweep bounds them.
   */
  noteToolCalls(session, event) {
    const msg = event?.data?.message || event?.data?.msg;
    const content = msg?.content;
    if (!Array.isArray(content)) return;
    const sid = this.sessionIdFrom({}, session);
    if (!sid) return;
    const at = Date.now();
    for (const block of content) {
      if (!block || block.type !== "tool-call" || !block.id) continue;
      const parsed = commandTextOfToolCall(block);
      const command = parsed.text;
      const pend = this.pendingCalls.get(sid) || [];
      pend.push({ id: block.id, at, command });
      if (pend.length > 40) pend.splice(0, pend.length - 40);
      this.pendingCalls.set(sid, pend);
      const list = this.list(sid);
      const existing = list.find((iv) => iv.callId === block.id);
      if (existing) {
        // Retry of the same tool call: refresh text and reopen the window.
        if (command && command !== existing.command) {
          existing.command = command;
          existing.exeHints = extractExeHints(parsed.full);
        }
        existing.startMs = at;
        existing.endMs = null;
      } else if (command && command.trim()) {
        // A new call starts while previous ones may still be open: close any
        // dangling interval of this session at "now" (a session issues calls
        // serially), so an abandoned window can never stretch to MAX.
        for (const iv of list) {
          if (iv.endMs === null) iv.endMs = at;
        }
        list.push({
          jobId: null,
          callId: block.id,
          command,
          exeHints: extractExeHints(parsed.full),
          startMs: at,
          endMs: null,
        });
        if (list.length > 200) list.splice(0, list.length - 200);
      }
    }
  }

  /** A tool-call issued within 5s before the job started is its caller. */
  correlateCallId(sid, jobData) {
    const pend = this.pendingCalls.get(sid);
    if (!pend || pend.length === 0) return null;
    const startedAt = Number(jobData.startedAt) || Date.now();
    for (let i = pend.length - 1; i >= 0; i--) {
      const c = pend[i];
      if (startedAt - c.at <= 5_000) {
        if (c.command && jobData.label && !jobData.label.includes(c.command.slice(0, 40)) && c.command.length > 4) {
          // Text mismatch: still plausible (label is the shell line, the
          // call held the script). Correlate anyway — better retry-chain
          // recall than precision here; mutex (c) only fires when BOTH
          // sides carry the same id.
        }
        pend.splice(0, i + 1);
        return c.id;
      }
    }
    return null;
  }

  list(sid) {
    let l = this.sessions.get(sid);
    if (!l) {
      l = [];
      this.sessions.set(sid, l);
    }
    return l;
  }

  allSessionIds() {
    return [...this.sessions.keys()];
  }

  /** Close abandoned windows, then drop intervals past the retention. */
  prune(now) {
    const retention = this.config.ledgerRetentionMs ?? 600_000;
    for (const [sid, list] of this.sessions) {
      for (const iv of list) {
        // An interval left open way past its start was abandoned (its settled
        // event never arrived). Close it at a sane point: an endMs of null
        // means "covering forever", which would inflate the medium channel.
        if (iv.endMs === null && now - iv.startMs > retention) {
          iv.endMs = iv.startMs + 60_000;
        }
      }
      const kept = list.filter((iv) => iv.endMs === null || now - iv.endMs <= retention);
      if (kept.length === 0) this.sessions.delete(sid);
      else this.sessions.set(sid, kept);
    }
  }

  /** Intervals of sid whose [start-before, end+after] covers ms. */
  covering(sid, ms, beforeMs, afterMs) {
    const b = beforeMs ?? this.config.timeWindowBeforeMs ?? 2_000;
    const a = afterMs ?? this.config.timeWindowAfterMs ?? 10_000;
    return this.list(sid).filter((iv) => {
      const end = iv.endMs ?? Number.MAX_SAFE_INTEGER;
      return ms >= iv.startMs - b && ms <= end + a;
    });
  }

  /** The interval covering ms with the closest start (or null). */
  closestCovering(sid, ms, beforeMs, afterMs) {
    const all = this.covering(sid, ms, beforeMs, afterMs);
    if (all.length === 0) return null;
    return all.reduce((best, iv) => (iv.startMs > best.startMs ? iv : best), all[0]);
  }

  /**
   * Sessions whose exeHints hit the dialog's exe (full path, or its
   * basename) — the H1/H3 strong-evidence predicate.
   */
  hintHits(exeFull, extraNames) {
    const hits = [];
    if (!exeFull && !(extraNames || []).length) return hits;
    const full = String(exeFull || "").toLowerCase();
    const base = baseName(full);
    const names = new Set((extraNames || []).map((n) => String(n).toLowerCase()));
    for (const [sid, list] of this.sessions) {
      for (const iv of list) {
        let hit = null;
        if (full && iv.exeHints.includes(full)) hit = { kind: "full-path", hint: full };
        else if (base && iv.exeHints.includes(base)) hit = { kind: "basename", hint: base };
        else {
          for (const n of names) {
            if (iv.exeHints.includes(n)) {
              hit = { kind: "name", hint: n };
              break;
            }
          }
        }
        // Second-acceptance 2.2: return EVERY matching interval. The old
        // `break` kept only the first hit per session, so once a session had
        // ANY earlier command mentioning the same exe, every later real
        // strong-evidence dialog was demoted to medium (the first hit's
        // window no longer covered the new process). The attributor's
        // `usable` filter picks the interval that covers the time window.
        if (hit) hits.push({ sessionId: sid, interval: iv, how: hit });
      }
    }
    return hits;
  }

  /**
   * Sessions whose ledgered command names this process (H2 owner-chain).
   * Matches either the exe basename (python.exe) or the bare command name
   * (python) with a word boundary — "python build.py" ledgered python.exe's
   * child dialogs through the owner chain even though the command text has
   * no ".exe" token.
   */
  ledgerExeHits(ownerExeBase) {
    if (!ownerExeBase) return [];
    const want = String(ownerExeBase).toLowerCase();
    const bare = want.replace(/\.exe$/, "").replace(/[^a-z0-9_\-]/g, "");
    const out = [];
    for (const [sid, list] of this.sessions) {
      for (const iv of list) {
        if (iv.exeHints.includes(want)) {
          out.push({ sessionId: sid, interval: iv });
          break;
        }
        if (bare.length >= 3 && new RegExp(`\\b${bare}\\b`, "i").test(iv.command)) {
          out.push({ sessionId: sid, interval: iv });
          break;
        }
      }
    }
    return out;
  }

  /** Mutex (c): two intervals belong to one retry chain (same tool call). */
  isRetryChain(ivA, ivB) {
    return Boolean(ivA?.callId && ivB?.callId && ivA.callId === ivB.callId);
  }

  /** Mutex (e) helper: did sid show any activity near ms? */
  recentlyActive(sid, ms, withinMs) {
    const list = this.list(sid);
    const last = list[list.length - 1];
    if (!last) return false;
    const ref = last.endMs ?? ms;
    return Math.abs(ms - ref) <= (withinMs ?? 90_000);
  }
}
