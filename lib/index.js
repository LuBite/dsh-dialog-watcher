/**
 * dsh-dialog-watcher — host half (cordis plugin entry).
 *
 * Architecture (Phase2 方案 §3): a resident PowerShell probe (Win32
 * EnumWindows + UIA, C# via Add-Type) reports blocking dialogs as JSON lines
 * on stdout. This half owns:
 *
 *   ledger      session command windows from session/event
 *   attributor  window -> session evidence + two-command/two-dialog machine
 *   injector    agent.steer under source kind plugin:dialog-watcher
 *   dialog_action  the model-facing tool (UIA Invoke -> Win32 BM_CLICK)
 *   probe lifecycle  spawn/kill/respawn, busy/idle cadence, zero residue
 *   web routes  toggle + panel data for the client half (loopback-only)
 *
 * Hard constraints honoured here: the probe is spawned by the host process
 * (NFR7), never via a session shell; paths derive from import.meta.url and
 * DSH_HOME (NFR4); every injection uses { kind: 'plugin:dialog-watcher' }
 * (constraint 3); nothing ever calls SetForegroundWindow (constraint 7).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, tryRequire } from "./store.js";
import { Ledger } from "./ledger.js";
import { Attributor } from "./attributor.js";
import { Injector, PLUGIN_KIND } from "./injector.js";
import {
  strongNotice,
  mediumNotice,
  smartScreenNotice,
  systemConsentNotice,
  goneNotice,
  summaryOf,
} from "./templates.js";

const require_ = createRequire(import.meta.url);
const defineTool = tryRequire("@deepseek-ai/dsh-tools")?.defineTool;

export const name = "dsh-dialog-watcher";
/**
 * An array, never an object — cordis reads an object inject as a
 * name→intercept map (see dsh-delete-message's TokenLedger note). All
 * optional services (webServer/webRuntime/tools) attach via nested
 * ctx.inject so the plugin still loads in profiles without them.
 */
export const inject = [];

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBER_DIR = normalize(join(HERE, "prober"));
const PROBE_PS1 = join(PROBER_DIR, "dialog_probe.ps1");

/**
 * Working directory for the spawned probe: deliberately NOT the install dir.
 * A Windows process holds its CWD directory locked for as long as it lives,
 * so `cwd: PROBER_DIR` made the plugin lock its own installation — uninstall,
 * upgrade, reinstall and even `pnpm` dependency pruning all failed with
 * EPERM while the watcher ran (caught during real-world profile surgery).
 * The probe never needed that CWD: the script is referenced with an absolute
 * `-File` path, and dialog_probe.ps1 locates DlgProbe.cs via $PSScriptRoot,
 * both independent of the process working directory. A scratch dir under
 * %TEMP% keeps the install tree movable at all times.
 */
const PROBE_WORK_DIR = join(tmpdir(), "dsh-dialog-watcher");

function ensureProbeWorkDir() {
  try {
    mkdirSync(PROBE_WORK_DIR, { recursive: true });
    return PROBE_WORK_DIR;
  } catch {
    return tmpdir(); // last resort: the system temp itself
  }
}

/** UI routes are single-endpoint dispatch, loopback/trusted-host gated. */
const API_PATH = "/dialog-watcher/api";
const MAX_RESTARTS = 5;

export function apply(ctx, config) {
  const log = (...a) => {
    try {
      ctx.logger?.info?.(`dialog-watcher: ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`);
    } catch {
      /* logging is best effort */
    }
  };
  const warn = (...a) => {
    try {
      ctx.logger?.warn?.(`dialog-watcher: ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`);
    } catch {
      /* ignore */
    }
  };

  if (!existsSync(PROBE_PS1)) {
    warn(`probe script missing at ${PROBE_PS1} — watcher stays idle`);
  }

  const store = new Store();
  let cfg = store.loadConfig();
  const ledger = new Ledger(cfg);
  const attributor = new Attributor({
    ledger,
    config: cfg,
    bindings: () => store.loadBindings(),
  });
  // Host service references. Deliberately NOT read as ctx.<name> properties:
  // cordis throws "cannot get property X without inject" on undeclared service
  // property access (P0-1 of the first acceptance round), and optional-chain
  // does NOT protect against it. We keep the plugin-level `inject = []` so a
  // missing service never blocks loading, and resolve each dependency through
  // a nested ctx.inject instead; until it arrives the corresponding feature
  // degrades quietly (NFR1).
  const services = { agents: null, sessionController: null, webServerSeen: false };
  ctx.inject(["agents"], (scoped) => {
    services.agents = scoped?.agents || null;
    log("service agents resolved");
  });
  ctx.inject(["sessionController"], (scoped) => {
    services.sessionController = scoped?.sessionController || null;
    log("service sessionController resolved");
  });
  const injector = new Injector({ services, store, log: warn });

  const state = {
    probeChild: null,
    probeReady: false,
    manualStop: false,
    restarts: 0,
    busy: false,
    pendingClicks: new Map(), // requestId -> {resolve, timer}
    lineBuf: "",
    stderrBuf: [],
    stoppingChild: null, // probe quitting; sync-killed before a new spawn
    toggledOffAt: 0,
  };
  const runningSessions = new Set();

  // ---------------------------------------------------------------- probe --

  function probeArgs(busyMs, idleMs) {
    return [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      PROBE_PS1,
      "-BusyMs",
      String(busyMs),
      "-IdleMs",
      String(idleMs),
    ];
  }

  function startProbe() {
    if (!cfg.probeOn || state.probeChild) return;
    if (!existsSync(PROBE_PS1)) return;
    // A quick 关→开 must not spawn the new probe while the old one still has
    // a pending delayed kill - that would leave two probes running for a few
    // seconds. Sync-kill any stopping child BEFORE spawning the new one.
    if (state.stoppingChild) {
      try {
        state.stoppingChild.kill();
      } catch {
        /* already gone */
      }
      state.stoppingChild = null;
    }
    state.manualStop = false;
    let child;
    try {
      child = spawn("powershell.exe", probeArgs(cfg.busyMs, cfg.idleMs), {
        cwd: ensureProbeWorkDir(), // never the install dir: CWD would lock it (EPERM on upgrade/uninstall)
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      warn("probe spawn failed:", String(error?.message || error));
      scheduleRestart();
      return;
    }
    state.probeChild = child;
    state.probeReady = false;
    log("probe spawned pid", child.pid);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // NFR1 hard rule: NOTHING that comes from the probe may throw into the
      // host process. A synchronous throw in this socket callback killed DSH
      // (first-acceptance P0-1); every line is therefore handled inside its
      // own guard, and the parser itself cannot escape.
      try {
        state.lineBuf += chunk;
        let idx;
        while ((idx = state.lineBuf.indexOf("\n")) >= 0) {
          const line = state.lineBuf.slice(0, idx).trim();
          state.lineBuf = state.lineBuf.slice(idx + 1);
          if (!line) continue;
          try {
            handleProbeLine(line);
          } catch (error) {
            warn("probe line handler failed:", String(error?.stack || error?.message || error).slice(0, 600));
            try {
              store.appendEvent({ ev: "handler-error", line: line.slice(0, 200), error: String(error?.message || error) });
            } catch {
              /* even the error log is best effort */
            }
          }
        }
      } catch (error) {
        warn("probe stdout parse failed:", String(error?.message || error));
        state.lineBuf = ""; // resync rather than corrupt every later line
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderrBuf.push(chunk);
      if (state.stderrBuf.length > 40) state.stderrBuf.shift();
    });
    child.on("exit", (code, signal) => {
      const wasReady = state.probeReady;
      // Only clear our own handle: if the host stopped us and restarted
      // quickly, the delayed kill of THIS child must not wipe the new one.
      if (state.probeChild === child) {
        state.probeChild = null;
        state.probeReady = false;
      }
      for (const [rid, p] of state.pendingClicks) {
        p.resolve({ ok: false, via: "probe-exited", error: "probe process exited" });
        clearTimeout(p.timer);
      }
      state.pendingClicks.clear();
      log(`probe exited code=${code} signal=${signal} ready=${wasReady}`);
      if (state.stderrBuf.length) warn("probe stderr tail:", state.stderrBuf.join("").slice(-800));
      state.stderrBuf = [];
      // A7: respawn while the toggle is on, unless we stopped it ourselves.
      if (cfg.probeOn && !state.manualStop && state.probeChild === null) scheduleRestart();
    });
    // Busy/idle cadence (§4.6): running sessions -> busyMs, all idle -> idleMs.
    sendProbe({ cmd: "interval", busy: state.busy });
  }

  function scheduleRestart() {
    state.restarts += 1;
    const delay = state.restarts > MAX_RESTARTS ? 60_000 : 2_000;
    setTimeout(() => {
      if (cfg.probeOn && !state.probeChild) {
        if (state.restarts > MAX_RESTARTS) state.restarts = 0; // slow lane reset
        startProbe();
      }
    }, delay).unref?.();
  }

  /**
   * Probe toggle OFF: quit via stdin, then kill; zero residue (§4.6).
   * `immediate` skips the 1.5s grace (used by applyConfig when the cadence
   * changed or when a restart must not overlap the old process).
   */
  function stopProbe(immediate) {
    state.manualStop = true;
    state.restarts = 0;
    const child = state.probeChild;
    state.probeChild = null;
    state.probeReady = false;
    if (!child) return;
    const killNow = () => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      if (state.stoppingChild === child) state.stoppingChild = null;
    };
    // Remember it so a fast 关→开 can sync-kill before spawning a new probe
    // (otherwise the delayed kill lets both run briefly).
    state.stoppingChild = child;
    try {
      child.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n");
    } catch {
      /* stdin may already be gone */
    }
    if (immediate) {
      killNow();
      return;
    }
    const killTimer = setTimeout(killNow, 1500);
    killTimer.unref?.();
  }

  function sendProbe(obj) {
    const child = state.probeChild;
    if (!child || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------- probe events --

  function handleProbeLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.ev) {
      case "ready":
        state.probeReady = true;
        state.restarts = 0;
        sendProbe({ cmd: "interval", busy: state.busy });
        log("probe ready pid", ev.pid);
        break;
      case "window":
        handleWindow(ev);
        break;
      case "gone":
        handleGone(ev);
        break;
      case "clickResult": {
        const rid = ev.requestId;
        const p = rid ? state.pendingClicks.get(rid) : null;
        if (p) {
          state.pendingClicks.delete(rid);
          clearTimeout(p.timer);
          p.resolve(ev);
        }
        break;
      }
      default:
        break; // window-all and unknown events are for diagnostics only
    }
  }

  /** Muted? whitelisted? then run attribution and maybe inject. */
  function handleWindow(ev) {
    try {
      const now = Date.now();
      // FR5.2 temporary mute from the UI.
      if (cfg.muteUntilMs && now < cfg.muteUntilMs) return;

      const exeBase = baseName(String(ev.exe || "")).toLowerCase();
      if (exeBase && (cfg.whitelist || []).some((w) => String(w).toLowerCase() === exeBase)) {
        if (cfg.debug) store.appendEvent({ ev: "whitelisted", hwnd: ev.hwnd, exe: ev.exe });
        return;
      }

      const decision = attributor.receive(ev, now);
      log(
        "window",
        ev.hwnd,
        ev.kind,
        "→",
        decision.action,
        decision.sessionId || "",
        decision.reason || ""
      );

      // FR6: full-trace records; unattributed windows only in debug (NFR3).
      if (decision.action !== "ignore" || cfg.debug) {
        store.appendEvent({
          ev: "window",
          hwnd: ev.hwnd,
          cls: ev.cls,
          title: ev.title,
          pid: ev.pid,
          exe: ev.exe,
          kind: ev.kind,
          smartScreenApp: ev.smartScreenApp || undefined,
        decision: {
          action: decision.action,
          level: decision.level,
          sessionId: decision.sessionId || null,
          evidence: decision.evidence,
          reason: decision.reason || undefined,
          // Ledger diagnostics from classify() — helps attribute "why not
          // strong" from the events log alone (first-acceptance P2-1).
          diag: decision.verdict?.diag || undefined,
        },
        });
      }

      if (decision.action === "inject-strong" || decision.action === "inject-medium") {
        const text = renderNotice(ev, decision);
        const summary = summaryOf(ev);
        injector
          .inject(decision.sessionId, text, summary, {
            hwnd: ev.hwnd,
            level: decision.level,
            action: decision.action,
          })
          .then((res) => {
            if (!res.ok && res.reason !== "subagent-skipped") {
              log("inject failed:", res.reason);
            }
          })
          .catch((error) => {
            // inject() is async; a rejection must degrade, never propagate.
            warn("inject rejected:", String(error?.message || error));
          });
      }
    } catch (error) {
      // Attribution/injection errors are the watcher's problem only (NFR1).
      warn("handleWindow failed:", String(error?.stack || error?.message || error).slice(0, 600));
      try {
        store.appendEvent({ ev: "handler-error", hwnd: ev?.hwnd, error: String(error?.message || error) });
      } catch {
        /* best effort */
      }
    }
  }

  function renderNotice(ev, decision) {
    if (decision.action === "inject-strong") {
      if (ev.kind === "smartscreen") return smartScreenNotice(ev, decision.evidence);
      if (ev.kind === "system-consent") return systemConsentNotice(ev, decision.evidence, false);
      return strongNotice(ev, decision.evidence);
    }
    // A consent card carries permanent consequences even when attribution is
    // only medium, so it keeps its own wording instead of the generic one.
    if (ev.kind === "system-consent") {
      return systemConsentNotice(ev, decision.evidence, true);
    }
    return mediumNotice(ev, decision.evidence, decision.pair || null);
  }

  /** FR3.6: light "unblocked" notice for sessions we already alerted. */
  function handleGone(ev) {
    try {
      const now = Date.now();
      const gone = attributor.gone(ev.hwnd, now);
      if (!gone) return;
      // Third acceptance 2.2: ignored windows never got a `window` record, so
      // logging their `gone` would create orphan lines that confuse log
      // readers. Log the disappearance only if the window itself was logged
      // (or in debug mode); the gone-notify injection below is unaffected.
      if (cfg.debug || attributor.loggedWindows.has(ev.hwnd)) {
        store.appendEvent({
          ev: "gone",
          hwnd: ev.hwnd,
          title: gone.ev.title,
          injected: Boolean(gone.injectedSessionId),
        });
      }
      if (gone.injectedSessionId && cfg.goneNotify) {
        const text = goneNotice(gone.ev);
        Promise.resolve(
          injector.inject(
            gone.injectedSessionId,
            text,
            `弹窗已解除：${gone.ev.title || gone.ev.exe || ""}`.slice(0, 110),
            { hwnd: ev.hwnd, level: "notice", action: "gone" }
          )
        ).catch((error) => warn("gone-notify rejected:", String(error?.message || error)));
      }
    } catch (error) {
      warn("handleGone failed:", String(error?.message || error));
    }
  }

  // ------------------------------------------------------ session hooks --

  ctx.on("session/event", (session, event) => {
    try {
      ledger.onSessionEvent(session, event);
      if (event?.type === "session/disposed") runningSessions.delete(String(session?.id || ""));
    } catch (error) {
      warn("session/event handler failed:", String(error?.message || error));
    }
  });

  ctx.on("agent/created", ({ agent }) => {
    if (!agent) return;
    const sid = String(agent.session?.id || agent.id || "").replace(/^session-/, "");
    try {
      agent.ctx.on("agent/status", ({ status }) => {
        try {
          if (status === "running") runningSessions.add(sid);
          else runningSessions.delete(sid);
          setBusy(runningSessions.size > 0);
        } catch (error) {
          warn("agent/status handler failed:", String(error?.message || error));
        }
      });
    } catch {
      /* agent context may be closing */
    }
  });

  function setBusy(busy) {
    if (state.busy === busy) return;
    state.busy = busy;
    sendProbe({ cmd: "interval", busy });
  }

  // ------------------------------------------------------------ tool ------

  // The output contract of planning-with-files' tools (the only third-party
  // reference that demonstrably registers tools on 0.2.x): a schema+render
  // pair, NOT a bare string. A bare `output: "json"` produced a tool that
  // never surfaced in the session tool table (first-acceptance P1-2).
  const JSON_TEXT = {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };

  if (defineTool) {
    ctx.inject(["tools"], (scoped) => {
      try {
        const tool = defineTool({
          name: "dialog_action",
          description:
            "Interact with a blocking Windows dialog that dialog-watcher reported in your injected event notice. " +
            "action 'invoke' clicks a button: pass intent (ok|cancel|run|dontrun) or button_text; " +
            "'close' sends WM_CLOSE; 'wait' does nothing and asks the user. Ordinary dialogs are clicked " +
            "without moving the mouse or stealing focus; system consent cards (kind 'system-consent') expose no " +
            "reachable button objects, so those get one real mouse click at the button centre instead.",
          // Flat shorthand, same shape planning-with-files uses and its tools
          // do register; optionality is described in the text only - an
          // `optional: true` key is not part of the accepted shorthand.
          parameters: {
            window_id: { type: "string", description: "hwnd from the notice, e.g. 0x1006C0" },
            action: { type: "string", description: "invoke | close | wait" },
            intent: { type: "string", description: "Only for invoke: ok | cancel | run | dontrun. Omit when passing button_text." },
            button_text: { type: "string", description: "Only for invoke: exact button label. Omit when passing intent." },
          },
          output: JSON_TEXT,
          async execute(args) {
            try {
              return JSON.stringify(await dialogAction(args || {}));
            } catch (error) {
              // A tool error must surface as a result, never as an exception
              // into the agent loop.
              warn("dialog_action execute failed:", String(error?.stack || error?.message || error).slice(0, 600));
              return JSON.stringify({ ok: false, error: "internal", detail: String(error?.message || error) });
            }
          },
        });
        scoped.tools.register(tool);
        log("dialog_action tool registered on scope keys:", Object.keys(scoped || {}).join(","));
      } catch (error) {
        warn("tool registration failed:", String(error?.stack || error?.message || error).slice(0, 600));
      }
    });
  } else {
    warn("@deepseek-ai/dsh-tools not resolvable — dialog_action tool not registered");
  }

  /** Safety gates + probe round-trip for the model-facing tool. */
  async function dialogAction(args) {
    const action = String(args.action || "");
    if (action === "wait") {
      return { ok: true, action: "wait", note: "没有执行任何操作；等待用户处理该弹窗。" };
    }
    if (!cfg.probeOn) return { ok: false, error: "probe-disabled", note: "弹窗监控已关闭，无法操作窗口。" };
    if (!cfg.clickOn) return { ok: false, error: "click-disabled", note: "代点开关未开启；请在界面开启「允许代点」。" };
    const hwnd = String(args.window_id || "");
    if (!/^0x[0-9a-fA-F]+$/.test(hwnd)) return { ok: false, error: "bad-window-id" };
    // Only windows the probe actually reported may be touched (constraint 3
    // of 制作要求: never auto-click anything that is not a reported target).
    if (!attributor.knownWindow(hwnd)) return { ok: false, error: "unknown-window", note: "该窗口不是本插件报告过的弹窗。" };
    if (action === "invoke") {
      if (!args.intent && !args.button_text) return { ok: false, error: "missing-target" };
      return probeRequest({ cmd: "click", hwnd, intent: args.intent || "", buttonText: args.button_text || "" });
    }
    if (action === "close") {
      return probeRequest({ cmd: "close", hwnd });
    }
    return { ok: false, error: "bad-action" };
  }

  function probeRequest(obj) {
    const requestId = `dw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { ...obj, requestId };
    if (!sendProbe(payload)) return Promise.resolve({ ok: false, error: "probe-not-running" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pendingClicks.delete(requestId);
        resolve({ ok: false, error: "timeout", note: "探测器 10 秒内未回应。" });
      }, 10_000);
      state.pendingClicks.set(requestId, { resolve, timer });
    });
  }

  // ------------------------------------------------------------ web -------

  // webServer and webRuntime are resolved SEPARATELY (second-acceptance 2.1):
  // the first-acceptance crash log showed plugins parked forever in "pending
  // (waiting for service: webRuntime)", and a joint inject(["webServer",
  // "webRuntime"]) inherits exactly that deadlock — the route then never
  // registers and the client faces three dead buttons. webRuntime only
  // supplies the trusted-hosts table; until it arrives the gate allows
  // loopback only, which is how the desktop web UI connects anyway.
  let trustedHosts = null;
  ctx.inject(["webRuntime"], (scope) => {
    trustedHosts = scope?.webRuntime?.trustedHosts || [];
    log("webRuntime resolved; trusted hosts:", Array.isArray(trustedHosts) ? trustedHosts.length : 0);
  });
  ctx.inject(["webServer"], (scope) => {
    ctx.effect(() => {
      scope.webServer.register({
        kind: "exact",
        path: API_PATH,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            sendJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          let body = {};
          try {
            body = await readJsonBody(req);
          } catch {
            body = {};
          }
          try {
            const method = String(req.method || "GET").toUpperCase() === "GET" ? String(body.method || "state") : String(body.method || "");
            switch (method) {
              case "state":
                sendJson(res, 200, statePayload());
                return;
              case "toggle": {
                const patch = {};
                if (typeof body.probe === "boolean") patch.probeOn = body.probe;
                if (typeof body.click === "boolean" && cfg.probeOn) patch.clickOn = body.click;
                if (typeof body.muteMinutes === "number") {
                  patch.muteUntilMs = body.muteMinutes > 0 ? Date.now() + body.muteMinutes * 60_000 : 0;
                }
                applyConfig(patch);
                sendJson(res, 200, statePayload());
                return;
              }
              case "bind": {
                if (typeof body.programId === "string" && typeof body.sessionId === "string") {
                  store.bind(body.programId, body.sessionId);
                  log("bound", body.programId, "->", body.sessionId);
                }
                sendJson(res, 200, statePayload());
                return;
              }
              case "unbind": {
                if (typeof body.programId === "string") store.unbind(body.programId);
                sendJson(res, 200, statePayload());
                return;
              }
              default:
                sendJson(res, 400, { ok: false, error: "unknown-method" });
            }
          } catch (error) {
            warn("api failed:", String(error?.message || error));
            sendJson(res, 500, { ok: false, error: "internal" });
          }
        },
      });
      log("serving", API_PATH);
      // Observability for the "dead buttons" class of failure: the events log
      // is the one channel proven to work in both acceptance rounds.
      try {
        store.appendEvent({ ev: "api-registered", path: API_PATH });
      } catch {
        /* best effort */
      }
    });
  });

  function applyConfig(patch) {
    if (typeof patch.probeOn === "boolean" && patch.probeOn !== cfg.probeOn) {
      // §4.6: probe off -> click unusable and NOT auto-restored when probe
      // comes back (the user re-enables it explicitly).
      if (patch.probeOn === false && cfg.clickOn) {
        patch.clickOn = false;
        log("probe off -> click disabled (won't auto-restore)");
      }
    }
    // Mute is session-scoped: keep it in memory only, never in config.json.
    const persist = { ...patch };
    delete persist.muteUntilMs;
    cfg = store.saveConfig(persist);
    if (typeof patch.muteUntilMs === "number") cfg.muteUntilMs = patch.muteUntilMs;
    attributor.config = cfg;
    ledger.config = cfg;
    // Probe cadence is a spawn argument: restart the resident probe so a
    // changed busyMs/idleMs takes effect immediately.
    const cadenceChanged = patch.busyMs !== undefined || patch.idleMs !== undefined;
    if (cfg.probeOn) {
      if (cadenceChanged && state.probeChild) stopProbe(true); // sync kill: no probe overlap
      startProbe();
    } else {
      stopProbe();
    }
  }

  function statePayload() {
    return {
      ok: true,
      plugin: name,
      probeOn: cfg.probeOn,
      clickOn: cfg.clickOn,
      probeAlive: Boolean(state.probeChild),
      busy: state.busy,
      muteUntilMs: cfg.muteUntilMs || 0,
      config: {
        busyMs: cfg.busyMs,
        idleMs: cfg.idleMs,
        throttleWindowMs: cfg.throttleWindowMs,
        throttleMax: cfg.throttleMax,
        goneNotify: cfg.goneNotify,
        debug: cfg.debug,
      },
      recent: attributor.recent.slice(-40).reverse(),
      pool: attributor.pool.slice(-40).reverse(),
      bindings: store.loadBindings(),
      aliveWindows: [...attributor.windows.keys()],
    };
  }

  // ---------------------------------------------------------- lifecycle ---

  const periodic = setInterval(() => {
    try {
      attributor.tick();
    } catch {
      /* keep-alive work never throws */
    }
  }, 30_000);
  periodic.unref?.();

  // cordis effect contract: the callback runs NOW and its RETURN VALUE is
  // the dispose function (same shape dsh-tag-toggle / dsh-pet-bridge use).
  ctx.effect(() => () => {
    // Plugin dispose: stop the probe, clear timers, zero background left.
    clearInterval(periodic);
    stopProbe();
    for (const [, p] of state.pendingClicks) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "plugin-disposed" });
    }
    state.pendingClicks.clear();
    log("disposed");
  });

  if (cfg.probeOn) startProbe();
  else log("probe disabled by config; watcher idle");

  log(`loaded (probe=${cfg.probeOn} click=${cfg.clickOn})`);
}

// ------------------------------------------------------------- helpers -----

function baseName(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function sendJson(res, status, value) {
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(value));
  } catch {
    /* client went away */
  }
}

async function readJsonBody(req) {
  if (req.method === "GET") return {};
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 1_000_000) throw new Error("body too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Loopback / trusted-host gate (same contract as dsh-tag-toggle). */
function isTrustedApiRequest(req, trustedHosts) {
  const hostHeader = typeof req.headers?.host === "string" ? req.headers.host : "";
  const hostname = hostHeader.split(":")[0].toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || hostname.startsWith("127.")) return true;
  const list = Array.isArray(trustedHosts) ? trustedHosts : [];
  const canonical = (entry) => {
    if (typeof entry === "string") {
      try {
        return new URL(`http://${entry}`).hostname.toLowerCase();
      } catch {
        return entry.toLowerCase();
      }
    }
    if (entry && typeof entry.hostname === "string") return entry.hostname.toLowerCase();
    return "";
  };
  if (list.some((entry) => canonical(entry) === hostname)) {
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      try {
        if (new URL(origin).host !== hostHeader) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  return false;
}

export { PLUGIN_KIND };
