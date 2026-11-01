/**
 * dsh-dialog-watcher — state-machine unit tests (T-5).
 *
 * Run with plain node, no DSH needed:
 *
 *     node test/cases.js
 *
 * Covers the acceptance list of 制作要求.md §5 T-5: single dialog -> pool;
 * two-command/two-dialog -> tentative injection; each of the five mutexes
 * rejecting one pairing; strong evidence injecting directly; throttling;
 * plus the ledger hint extraction and the graded injection copy.
 */

import assert from "node:assert/strict";
import { Ledger, extractExeHints } from "../lib/ledger.js";
import { Attributor, MUTEX, programIdOf } from "../lib/attributor.js";
import {
  strongNotice,
  mediumNotice,
  smartScreenNotice,
  systemConsentNotice,
  goneNotice,
  kindLabel,
  buttonLines,
  INSTALL_RULES,
} from "../lib/templates.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`FAIL  ${name}\n      ${error?.message || error}`);
  }
}

/** A fake session-event bus feeding the ledger like the host would. */
function makeLedger(cfg) {
  const ledger = new Ledger(cfg);
  function job(sid, jobId, label, startMs, endMs, callId) {
    ledger.onSessionEvent(
      { id: sid },
      {
        type: "job/registered",
        data: { jobId, owner: `session-${sid}`, kind: "bash", label, startedAt: startMs },
      }
    );
    if (endMs !== null && endMs !== undefined) {
      ledger.onSessionEvent(
        { id: sid },
        {
          type: "job/settled",
          data: { jobId, owner: `session-${sid}`, kind: "bash", label, startedAt: startMs, finishedAt: endMs },
        }
      );
    }
    if (callId) {
      const iv = ledger.list(sid).find((x) => x.jobId === jobId);
      if (iv) iv.callId = callId;
    }
  }
  return { ledger, job };
}

/** Minimal probe "window" event. */
function win(hwnd, opts = {}) {
  return {
    ev: "window",
    hwnd,
    cls: opts.cls || "#32770",
    title: opts.title || "T",
    pid: opts.pid || 4242,
    exe: opts.exe === undefined ? "C:\\apps\\thing.exe" : opts.exe,
    procCreateMs: opts.procCreateMs === undefined ? 15_000 : opts.procCreateMs,
    ownerHwnd: "0x0",
    ownerPid: 0,
    ownerExe: opts.ownerExe || "",
    rect: [0, 0, 400, 200],
    foreground: false,
    body: opts.body || [],
    buttons: [{ hwnd: "0x" + hwnd.slice(2) + "0", ctrlId: 2, text: "确定", cls: "Button" }],
    uiaButtons: [],
    still: true,
    firstSeenMs: opts.firstSeenMs === undefined ? 16_000 : opts.firstSeenMs,
    kind: opts.kind || "app-error",
    smartScreen: Boolean(opts.smartScreen),
    smartScreenApp: opts.smartScreenApp || "",
    // Interceptor-dialog extras reported by the probe.
    interceptor: Boolean(opts.interceptor),
    sessionProcs: opts.sessionProcs || [],
    selfSession: opts.selfSession || "",
  };
}

function makeAttributor(ledger, cfg = {}, bindings = {}) {
  return new Attributor({
    ledger,
    config: cfg,
    bindings: () => bindings,
  });
}

// ---------------------------------------------------------------- cases ----

test("C1 strong evidence (exe hint + process time window) injects directly", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", ".\\setup_x64.exe /S", 10_000, 20_000);
  const a = makeAttributor(ledger);
  const d = a.receive(win("0x1", { exe: "C:\\dl\\setup_x64.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d.action, "inject-strong");
  assert.equal(d.sessionId, "A");
});

test("C1b basename-only command hint still hits strongly", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "node.exe crashed after build", 10_000, 20_000);
  const a = makeAttributor(ledger);
  const d = a.receive(win("0x2", { exe: "C:\\Program Files\\nodejs\\node.exe", procCreateMs: 14_000 }), 16_000);
  assert.equal(d.action, "inject-strong");
});

test("C2 single medium-evidence dialog does NOT inject; it pends, then pools", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm install foo", 10_000, 20_000); // no exe hint in command
  const a = makeAttributor(ledger, { mediumTimeoutMs: 60_000 });
  const d1 = a.receive(win("0x3", { exe: "C:\\py\\python.exe", procCreateMs: 15_000 }), 16_000);
  assert.equal(d1.action, "pending", "first sighting must not inject");
  assert.equal(a.pool.length, 0, "first sighting must not pool yet");
  a.tick(90_000); // past the 60s timeout
  assert.equal(a.pool.length, 1, "timed-out pending must flow into the pool");
});

test("C3 two-command/two-dialog sequence injects tentatively", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run build", 10_000, 20_000);
  job("A", "j2", "npm run test:e2e", 30_000, 40_000);
  const a = makeAttributor(ledger);
  const d1 = a.receive(win("0xA1", { exe: "C:\\x\\builder.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d1.action, "pending");
  const d2 = a.receive(
    win("0xA2", { exe: "C:\\x\\builder.exe", procCreateMs: 35_000, firstSeenMs: 36_000 }),
    36_000
  );
  assert.equal(d2.action, "inject-medium");
  assert.equal(d2.sessionId, "A");
  assert.ok(d2.pair, "medium injection carries the pairing info");
});

test("C4 mutex (c): same callId retry chain is refused", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run build", 10_000, 20_000, "call_00_RETRY");
  job("A", "j2", "npm run build", 30_000, 40_000, "call_00_RETRY"); // model retried the same call
  const a = makeAttributor(ledger);
  a.receive(win("0xB1", { exe: "C:\\x\\builder.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  const d2 = a.receive(win("0xB2", { exe: "C:\\x\\builder.exe", procCreateMs: 35_000, firstSeenMs: 36_000 }), 36_000);
  assert.equal(d2.action, "pool");
  assert.equal(d2.reason, MUTEX.RETRY_CHAIN);
  assert.ok(a.pending.size === 0, "both sides leave the pending state");
});

test("C5 a strong injection does not silence later dialogs of the same program", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "builder.exe --all", 10_000, 20_000); // strong hit
  job("A", "j2", "npm run again", 30_000, 40_000); // medium-only (no hint)
  const a = makeAttributor(ledger);
  const first = a.receive(win("0xC0", { exe: "C:\\x\\builder.exe", procCreateMs: 15_000 }), 16_000);
  assert.equal(first.action, "inject-strong");
  // Second dialog of the SAME program but with medium evidence only. There is
  // no per-program mark: every dialog the session actually caused must be
  // evaluated and announced, even if the same program already injected once.
  const d = a.receive(win("0xC1", { exe: "C:\\x\\builder.exe", procCreateMs: 35_000, firstSeenMs: 36_000 }), 36_000);
  assert.equal(d.action, "pending", "later dialogs must not be discarded because of an earlier one");
  assert.equal(a.pending.size, 1, "it enters the medium judgement state instead");
});

test("C6 mutex (b): a dialog cannot be consumed by two pairings", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run build", 10_000, 20_000);
  job("A", "j2", "npm run test:e2e", 30_000, 40_000);
  job("A", "j3", "npm run test:unit", 50_000, 60_000);
  job("A", "j4", "npm run test:int", 70_000, 80_000);
  const a = makeAttributor(ledger);
  a.receive(win("0xD1", { exe: "C:\\x\\builder.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  const paired = a.receive(win("0xD2", { exe: "C:\\x\\builder.exe", procCreateMs: 35_000, firstSeenMs: 36_000 }), 36_000);
  assert.equal(paired.action, "inject-medium");
  // Mark 0xD2's identity as already consumed, then replay it as a NEW event
  // paired with a fresh pending E1 on a different command window: mutex (b)
  // must refuse the second pairing.
  a.paired.set("0xD2", 36_000);
  a.receive(win("0xD3", { exe: "C:\\x\\builder.exe", procCreateMs: 55_000, firstSeenMs: 56_000 }), 56_000);
  const d = a.receive(win("0xD2", { exe: "C:\\x\\builder.exe", procCreateMs: 75_000, firstSeenMs: 76_000 }), 76_000);
  assert.equal(d.action, "pool");
  assert.equal(d.reason, MUTEX.PAIRED_ALREADY);
});

test("C7 mutex (d): 3+ sightings of one program in 5 minutes only take the first pair", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run build", 10_000, 20_000);
  job("A", "j2", "npm run test:e2e", 30_000, 40_000);
  job("A", "j3", "npm run test:unit", 50_000, 60_000);
  job("A", "j4", "npm run test:int", 70_000, 80_000);
  const a = makeAttributor(ledger);
  a.receive(win("0xE1", { exe: "C:\\x\\builder.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  const p2 = a.receive(win("0xE2", { exe: "C:\\x\\builder.exe", procCreateMs: 35_000, firstSeenMs: 36_000 }), 36_000);
  assert.equal(p2.action, "inject-medium", "first pair goes through");
  a.receive(win("0xE3", { exe: "C:\\x\\builder.exe", procCreateMs: 55_000, firstSeenMs: 56_000 }), 56_000);
  const p4 = a.receive(win("0xE4", { exe: "C:\\x\\builder.exe", procCreateMs: 75_000, firstSeenMs: 76_000 }), 76_000);
  assert.equal(p4.action, "pool");
  assert.equal(p4.reason, MUTEX.FLOOD);
});

test("C8 mutex (e): ambiguous candidate sessions never enter the machine", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm install alpha", 10_000, 20_000);
  job("B", "j1", "npm install beta", 10_000, 20_000);
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xF1", { exe: "C:\\py\\python.exe", procCreateMs: 15_000 }), 16_000);
  assert.equal(d.action, "pool");
  assert.equal(d.reason, MUTEX.SESSION_UNSTABLE);
  assert.equal(d.sessionId, null);
});

test("C9 throttle: more than 3 notices per 60s per session are pooled", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "setup.exe install", 0, 120_000);
  const a = makeAttributor(ledger);
  const outs = [];
  for (let i = 1; i <= 4; i++) {
    outs.push(a.receive(win(`0x10${i}`, { exe: "C:\\dl\\setup.exe", procCreateMs: i * 100, firstSeenMs: i * 100 }), i * 100));
  }
  assert.equal(outs[0].action, "inject-strong");
  assert.equal(outs[1].action, "inject-strong");
  assert.equal(outs[2].action, "inject-strong");
  assert.equal(outs[3].action, "pool");
  assert.match(outs[3].reason, /throttled/);
});

test("C10 no evidence anywhere -> silently ignored", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const d = a.receive(win("0x11", { exe: "C:\\games\\game.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d.action, "ignore");
  assert.equal(a.pool.length, 0);
});

test("C11 SmartScreen app-field match is strong and carries the install rules", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", ".\\dsh-pet-setup-v4.3.3.exe /S", 10_000, 60_000);
  const a = makeAttributor(ledger);
  const d = a.receive(
    win("0x12", {
      cls: "ApplicationFrameWindow",
      exe: "C:\\Windows\\explorer.exe",
      procCreateMs: 9_000,
      smartScreen: true,
      smartScreenApp: "dsh-pet-setup-v4.3.3.exe",
      firstSeenMs: 16_000,
      kind: "smartscreen",
    }),
    16_000
  );
  assert.equal(d.action, "inject-strong");
});

test("C12 manual binding makes later dialogs strong", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger, {}, { "c:\\dl\\mystery.exe": { sessionId: "Z", at: 1 } });
  const d = a.receive(win("0x13", { exe: "C:\\dl\\mystery.exe", procCreateMs: null, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d.action, "inject-strong");
  assert.equal(d.sessionId, "Z");
});

test("C13 ledger: retry-chain detection and interval covering", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run build", 10_000, 20_000, "call_00_X");
  job("A", "j2", "npm run build", 30_000, 40_000, "call_00_X");
  job("A", "j3", "npm run other", 50_000, 60_000, "call_00_Y");
  const list = ledger.list("A");
  assert.ok(ledger.isRetryChain(list[0], list[1]));
  assert.ok(!ledger.isRetryChain(list[0], list[2]));
  assert.equal(ledger.closestCovering("A", 15_000).jobId, "j1");
  assert.equal(ledger.closestCovering("A", 35_000).jobId, "j2");
  // 45s is 5s after j2 ended — still inside the +10s after-window (§4.3),
  // which is exactly what keeps "command returned, dialog popped later" covered.
  assert.equal(ledger.closestCovering("A", 45_000).jobId, "j2");
  assert.equal(ledger.closestCovering("A", 72_000), null, "well past the after-window is not covered");
});

test("C14 exe hint extraction pulls basenames and full paths", () => {
  const hints = extractExeHints('cmd /c "C:\\Downloads\\setup_x64.exe" /S && foo.msi');
  assert.ok(hints.includes("c:\\downloads\\setup_x64.exe"), JSON.stringify(hints));
  assert.ok(hints.includes("setup_x64.exe"));
  assert.ok(hints.includes("foo.msi"));
});

test("C15 owner-chain evidence is strong (H2)", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "python build.py", 10_000, 60_000);
  const a = makeAttributor(ledger);
  const d = a.receive(
    win("0x14", {
      exe: "C:\\Windows\\SysWOW64\\msiexec.exe",
      procCreateMs: 20_000,
      ownerExe: "C:\\Python312\\python.exe",
      firstSeenMs: 21_000,
    }),
    21_000
  );
  assert.equal(d.action, "inject-strong");
  assert.equal(d.how, "owner-chain");
});

test("C16 gone(): returns the injected session for the unblock notice", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "setup.exe install", 0, 120_000);
  const a = makeAttributor(ledger);
  a.receive(win("0x15", { exe: "C:\\dl\\setup.exe", procCreateMs: 100 }), 100);
  const g = a.gone("0x15", 5_000);
  assert.equal(g.injectedSessionId, "A");
  assert.ok(!a.windows.has("0x15"));
});

// ------------------------------------------- first-acceptance regressions ----

test("R1 (P2-1) a tool-call alone ledgered the command: strong without any job event", () => {
  // The exact first-acceptance scenario: DSH ran a dialog-spawning command,
  // the window matched, but the runtime ledger had no usable hints and the
  // dialog was demoted to medium. The tool-call block (which carries the
  // arguments text) must ledger the command by itself.
  const ledger = new Ledger({});
  ledger.onSessionEvent(
    { id: "A" },
    {
      type: "assistant/message",
      data: {
        message: {
          content: [
            {
              type: "tool-call",
              id: "call_00_E2E",
              name: "bash",
              arguments:
                'powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).Popup(\'x\',0,\'DW-E2E-TITLE\')" &',
            },
          ],
        },
      },
    }
  );
  const iv = ledger.list("A")[0];
  assert.ok(iv, "tool-call must ledger an interval");
  assert.deepEqual(iv.exeHints, ["powershell.exe"]);
  const a = makeAttributor(ledger);
  const d = a.receive(
    win("0xE2E", {
      exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      procCreateMs: iv.startMs + 500,
      firstSeenMs: iv.startMs + 600,
      title: "DW-E2E-TITLE",
    }),
    iv.startMs + 600
  );
  assert.equal(d.action, "inject-strong", `expected strong, got ${d.action}: ${d.evidence}`);
  assert.equal(d.how, "exe-hint+time");
});

test("R2 (P2-1) job/registered attaches to the tool-call interval and settled closes it", () => {
  const ledger = new Ledger({});
  ledger.onSessionEvent(
    { id: "A" },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "tool-call", id: "call_1", name: "bash", arguments: "setup.exe /S" }] } },
    }
  );
  ledger.onSessionEvent(
    { id: "A" },
    { type: "job/registered", data: { jobId: "bash-x", owner: "session-A", kind: "bash", label: "setup.exe /S", startedAt: Date.now() } }
  );
  const list = ledger.list("A");
  assert.equal(list.length, 1, "job/registered must attach, not duplicate");
  assert.equal(list[0].jobId, "bash-x");
  assert.equal(list[0].callId, "call_1");
  ledger.onSessionEvent(
    { id: "A" },
    { type: "job/settled", data: { jobId: "bash-x", owner: "session-A", startedAt: list[0].startMs, finishedAt: list[0].startMs + 5_000 } }
  );
  assert.ok(list[0].endMs !== null, "settled must close the interval");
});

test("R3 (P0-1) Injector without the agents service degrades instead of throwing", async () => {
  const { Injector } = await import("../lib/injector.js");
  const events = [];
  const store = { appendEvent: (r) => events.push(r) };
  const inj = new Injector({ services: { agents: null, sessionController: null }, store, log: () => {} });
  const res = await inj.inject("A", "text", "summary", {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "agents-service-unavailable");
  assert.equal(events.length, 1);
  // A live-looking agents registry passes through to agent-not-live.
  const inj2 = new Injector({ services: { agents: { get: () => null }, sessionController: null }, store, log: () => {} });
  const res2 = await inj2.inject("A", "text", "summary", {});
  assert.equal(res2.reason, "agent-not-live");
});

test("R4 (P0-1) a throwing agents registry is caught inside inject()", async () => {
  const { Injector } = await import("../lib/injector.js");
  const boom = { get: () => { throw new Error("cannot get property"); } };
  const inj = new Injector({ services: { agents: boom, sessionController: null }, store: { appendEvent: () => {} }, log: () => {} });
  const res = await inj.inject("A", "text", "summary", {});
  assert.equal(res.ok, false);
  assert.notEqual(res.reason, undefined);
});

test("R5 (P2-1) medium evidence carries ledger diagnostics in verdict.diag", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "build the project", 10_000, 20_000); // no exe hint, no launcher token
  const a = makeAttributor(ledger);
  const d = a.receive(win("0x3", { exe: "C:\\py\\python.exe", procCreateMs: 15_000 }), 16_000);
  assert.equal(d.action, "pending");
  assert.ok(d.verdict.diag, "medium verdict must carry diag for the events log");
  assert.equal(d.verdict.diag.exeBase, "python.exe");
  assert.deepEqual(d.verdict.diag.coveringHints, []);
});

test("R6 (mutex c via tool-call) same callId retried stays one interval and one chain", () => {
  const ledger = new Ledger({});
  const block = { type: "tool-call", id: "call_R", name: "bash", arguments: "npm run build" };
  ledger.onSessionEvent({ id: "A" }, { type: "assistant/message", data: { message: { content: [block] } } });
  const len1 = ledger.list("A").length;
  ledger.onSessionEvent({ id: "A" }, { type: "assistant/message", data: { message: { content: [block] } } });
  assert.equal(ledger.list("A").length, len1, "same callId must reuse the interval");
  const a = makeAttributor(ledger);
  // Two dialogs inside the SAME (refreshed) interval on the medium channel
  // (exe not hinted in the command): C1 === C2 -> same-command refusal.
  const iv = ledger.list("A")[0];
  a.receive(win("0xR1", { exe: "C:\\x\\builder.exe", procCreateMs: iv.startMs + 100, firstSeenMs: iv.startMs + 200 }), iv.startMs + 200);
  const d2 = a.receive(
    win("0xR2", { exe: "C:\\x\\builder.exe", procCreateMs: iv.startMs + 300, firstSeenMs: iv.startMs + 400 }),
    iv.startMs + 400
  );
  assert.equal(d2.action, "pool");
  assert.equal(d2.reason, "same-command");
});

test("R7 (second acceptance 2.2) an older same-exe command must not shadow a real strong hit", () => {
  // The exact second-acceptance trap: hintHits' per-session `break` kept the
  // FIRST command mentioning the exe; its window no longer covered the new
  // process, so every later true strong hit was demoted to medium.
  const { ledger, job } = makeLedger();
  job("A", "j1", "powershell.exe build-stage", 10_000, 20_000); // old, hint matches, window doesn't
  job("A", "j2", "powershell.exe run-stage", 100_000, 110_000); // the real trigger
  const hits = ledger.hintHits("c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe");
  assert.equal(hits.length, 2, "hintHits must return every matching interval");
  const a = makeAttributor(ledger);
  const d = a.receive(
    win("0xV2", {
      exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      procCreateMs: 105_000,
      firstSeenMs: 105_500,
      title: "DW-VERIFY-2",
    }),
    105_500
  );
  assert.equal(d.action, "inject-strong", `expected strong, got ${d.action}: ${d.evidence}`);
  assert.equal(d.how, "exe-hint+time");
  assert.equal(d.sessionId, "A");
});

test("R8 a run_code payload yields a readable label but NO hints", () => {
  const ledger = new Ledger({});
  // Real DSH shape: arguments is a JSON STRING holding a run_code payload.
  const args = JSON.stringify({
    code: 'const wd = "D:/projects/demo";\nconst f = wd + "/makeDlg.vbs";\nexec("wscript.exe //nologo " + f)',
  });
  ledger.onSessionEvent(
    { id: "A" },
    { type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "call_C", name: "run_code", arguments: args }] } } }
  );
  const iv = ledger.list("A")[0];
  assert.ok(!iv.command.startsWith("{"), "command must not be the raw JSON blob");
  assert.match(iv.command, /wscript\.exe/, "the summary still shows the executable line");
  assert.deepEqual(iv.exeHints, [], "run_code SOURCE must never seed exe hints");
});

test("R9 real multi-line commands keep their path separators", () => {
  // The old pre-processing replaced EVERY literal backslash-n/r/t with a space,
  // which turned "D:\nodejs\node.exe" into " ode.exe". Multi-line text needs no
  // pre-processing at all — the hint regex never crosses a newline.
  const a = extractExeHints("D:\\nodejs\\node.exe -v");
  assert.ok(a.includes("node.exe"), `path separator survives, got ${JSON.stringify(a)}`);
  assert.ok(!a.includes("ode.exe"), `no truncated name, got ${JSON.stringify(a)}`);
  const b = extractExeHints("cd work\nnode.exe server.js");
  assert.ok(b.includes("node.exe"), `multi-line still works, got ${JSON.stringify(b)}`);
  // JSON-escape residue ("foo\\npowershell.exe") is the upstream parser job:
  // from the text alone it is indistinguishable from a real path segment, so
  // extractExeHints must not guess. commandTextOfToolCall never feeds it that.
});

test("R10 (third acceptance 2.1) summary never picks an argument-assignment line", () => {
  const ledger = new Ledger({});
  // The exact third-acceptance case: a run_code script whose assignment line
  // mentions a .ps1 path must not be picked as the "command".
  const args = JSON.stringify({
    code: [
      'const wd = "D:/projects/demo";',
      'const p = wd + "/.tmp-acc3/dlg7.ps1";',
      'file_path: wd + "/.tmp-acc3/dlg7.ps1",',
      'exec("powershell.exe -NoProfile -ExecutionPolicy Bypass -File " + p)',
    ].join("\n"),
  });
  ledger.onSessionEvent(
    { id: "A" },
    { type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "call_S", name: "run_code", arguments: args }] } } }
  );
  const iv = ledger.list("A")[0];
  assert.ok(!iv.command.includes("file_path:"), `no assignment line in summary, got ${iv.command}`);
  assert.match(iv.command, /powershell\.exe/, `summary is the executable line, got ${iv.command}`);
});

test("R11 (third acceptance 2.2) ignored windows are not marked as logged", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  // No ledger at all -> ignore -> must NOT be marked logged.
  const d1 = a.receive(win("0xIG", { exe: "C:\\games\\game.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d1.action, "ignore");
  assert.ok(!a.loggedWindows.has("0xIG"), "ignored hwnd must not be logged");
  // A strong hit IS logged, so its later `gone` may appear in the events log.
  jobHelper(ledger, "A", "j1", "setup.exe install", 0, 120_000);
  const d2 = a.receive(win("0xIN", { exe: "C:\\dl\\setup.exe", procCreateMs: 100, firstSeenMs: 100 }), 100);
  assert.equal(d2.action, "inject-strong");
  assert.ok(a.loggedWindows.has("0xIN"), "injected hwnd must be marked logged");
});

function jobHelper(ledger, sid, jobId, label, startMs, endMs) {
  ledger.onSessionEvent(
    { id: sid },
    { type: "job/registered", data: { jobId, owner: `session-${sid}`, kind: "bash", label, startedAt: startMs } }
  );
  ledger.onSessionEvent(
    { id: sid },
    { type: "job/settled", data: { jobId, owner: `session-${sid}`, label, startedAt: startMs, finishedAt: endMs } }
  );
}

test("R12 (third acceptance 2.4) .ps1 names never become exe hints", () => {
  const hints = extractExeHints('powershell.exe -NoProfile -File "./.tmp-acc3/dlg7.ps1"');
  assert.ok(hints.includes("powershell.exe"), JSON.stringify(hints));
  assert.ok(!hints.some((h) => h.endsWith(".ps1")), `ps1 must not be a hint, got ${JSON.stringify(hints)}`);
});

// ------------------------------------------------------------ templates ----

test("T1 strong notice may state attribution and lists buttons", () => {
  const ev = win("0x16", { title: "安装失败", body: ["丢失 VCRUNTIME140.dll"], exe: "C:\\dl\\setup_x64.exe" });
  const text = strongNotice(ev, "该进程由你 4 秒前执行的命令启动");
  assert.match(text, /\[事件提醒\]/);
  assert.match(text, /setup_x64\.exe/);
  assert.match(text, /安装失败/);
  assert.match(text, /丢失 VCRUNTIME140\.dll/);
  assert.match(text, /dialog_action/);
});

test("T1b every notice carries the window handle dialog_action needs", () => {
  const ev = win("0x2A15B6", { title: "T" });
  // dialog_action rejects anything that is not 0x-prefixed and probe-reported,
  // so a notice that omits the handle makes the tool unusable.
  for (const text of [
    strongNotice(ev, "x"),
    mediumNotice(ev, "x"),
    smartScreenNotice(ev, "x"),
    systemConsentNotice(ev, "x", false),
    systemConsentNotice(ev, "x", true),
  ]) {
    assert.match(text, /- 窗口句柄：0x2A15B6/);
  }
});

test("T2 medium notice stays tentative (never asserts causality)", () => {
  const ev = win("0x17", { exe: "C:\\x\\foo.exe", title: "Foo 遇到问题" });
  const text = mediumNotice(ev, "时间线索", { commandA: "npm run build", commandB: "npm run test" });
  assert.match(text, /可能.*有关，也可能无关/);
  assert.match(text, /请你(自己)?判断/);
  assert.ok(!/归属依据：强/.test(text));
});

test("T3 installer scenarios embed the mandatory conduct rules verbatim", () => {
  const ev = win("0x18", { kind: "installer-wizard", title: "Setup", exe: "C:\\dl\\setup.exe" });
  const text = strongNotice(ev, "installer hint");
  assert.ok(text.includes(INSTALL_RULES));
  const ss = smartScreenNotice(
    win("0x19", { kind: "smartscreen", smartScreenApp: "setup.exe", exe: "C:\\Windows\\explorer.exe" }),
    "app field match"
  );
  assert.ok(ss.includes(INSTALL_RULES));
});

test("T5 gone notice is lightweight", () => {
  const text = goneNotice(win("0x1A", { title: "安装失败", exe: "C:\\dl\\setup_x64.exe" }));
  assert.match(text, /阻塞已解除/);
  assert.ok(text.length < 300);
});

/** Windows Security Center consent card as the probe reports it. */
function consentEvent() {
  const ev = win("0x1B", { kind: "system-consent", title: "Windows 安全中心" });
  ev.cls = "Shell_SystemDialogProxy";
  ev.exe = "C:\\Windows\\System32\\PickerHost.exe";
  ev.buttons = [
    { hwnd: "0x0", ctrlId: 1, text: "按钮#1(左)", cls: "PixelButton", pixel: "213,531" },
    { hwnd: "0x0", ctrlId: 2, text: "按钮#2(右)", cls: "PixelButton", pixel: "518,531" },
  ];
  return ev;
}

test("T6 system-consent notice states the permanent consequences", () => {
  const ev = consentEvent();
  const text = systemConsentNotice(ev, "同一时间窗内你执行了 node 监听", false);
  assert.match(text, /永久放行/);
  assert.match(text, /永久阻止/);
  assert.match(text, /只会询问一次/);
  assert.match(text, /最左=允许，最右=取消/);
  assert.match(text, /像素坐标 213,531/);
  assert.ok(!text.includes(INSTALL_RULES), "a firewall ask is not an install flow");
});

test("T7 consent notice keeps the tentative wording on medium evidence", () => {
  const med = systemConsentNotice(consentEvent(), "时间线索", true);
  assert.match(med, /可能.*有关，也可能无关/);
  assert.ok(!/归属依据：强/.test(med), "medium evidence must never assert causality");
  assert.match(med, /永久放行/);
});

test("T8 positional consent buttons are graded by side, not by unknown text", () => {
  const lines = buttonLines(consentEvent()).join("\n");
  assert.match(lines, /按钮#1\(左\).*L3/);
  assert.match(lines, /按钮#2\(右\).*L1/);
  assert.match(lines, /像素坐标 213,531/);
  assert.ok(!/Win32 hwnd 0x0/.test(lines), "pixel buttons must not claim a Win32 hwnd");
  assert.equal(kindLabel({ kind: "system-consent" }), "系统安全询问");
});

test("S1 a window process carrying DSH_SESSION_ID is a strong self-session hit", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xS1", { exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", selfSession: "session-abc123" }), 16_000);
  assert.equal(d.action, "inject-strong");
  assert.equal(d.level, "strong");
  assert.equal(d.sessionId, "abc123", "session- prefix is normalized away");
  assert.match(d.evidence, /带会话标记/);
});

test("S2 no selfSession falls through to the normal ladder", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xS2", { exe: "C:\\x\\thing.exe", selfSession: "" }), 16_000);
  assert.notEqual(d.action, "inject-strong");
});

test("S3 an interceptor window is unaffected: its own process has no marker", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const ev = win("0xS3", { exe: "C:\\Windows\\System32\\PickerHost.exe", interceptor: true, selfSession: "",
    sessionProcs: [{ pid: 900, exe: "bash.exe", createMs: 10_000, sessionId: "session-abc123" }] });
  const d = a.receive(ev, 16_000);
  assert.equal(d.action, "inject-strong");
  assert.match(d.evidence, /拦截类弹窗/);
});

test("S4 a user-launched app (no marker) never becomes self-session", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xS4", { exe: "C:\\Program Files\\WeChat\\WeChat.exe", selfSession: "" }), 16_000);
  assert.ok(d.level !== "strong", "a process without the marker must not be attributed");
});

// -------------------------------------------- attribution edge cases -------

test("backslash-n inside a real Windows path must not truncate the name", () => {
  const a = extractExeHints("D:\\nodejs\\node.exe -v");
  assert.ok(a.includes("node.exe"), "expected node.exe, got " + JSON.stringify(a));
  assert.ok(!a.includes("ode.exe"), "must never mint the truncated 'ode.exe'");
  const b = extractExeHints("C:\\Program Files\\nodejs\\node.exe --version");
  assert.ok(b.includes("node.exe"), "expected node.exe, got " + JSON.stringify(b));
  const c = extractExeHints("cd D:\\work\nnode.exe server.js");
  assert.ok(c.includes("node.exe"), "multi-line must still work, got " + JSON.stringify(c));
});

test("bare interpreter invoked without .exe still yields a hint", () => {
  assert.ok(extractExeHints("powershell -NoProfile -File x.ps1").includes("powershell.exe"));
  assert.ok(extractExeHints("node server.js").includes("node.exe"));
  assert.ok(extractExeHints("python main.py").includes("python.exe"));
  assert.ok(extractExeHints("cd work && npm run build").includes("npm.exe"));
  // an incidental word in the middle of a command must NOT become a hint
  assert.ok(!extractExeHints("echo node is great").includes("node.exe"));
});

test("run_code source code must not seed exe hints", () => {
  const { ledger } = makeLedger();
  ledger.onSessionEvent({ id: "A" }, {
    type: "assistant/message",
    data: {
      message: {
        content: [{
          type: "tool-call",
          id: "call-run-1",
          name: "run_code",
          arguments: JSON.stringify({ code: "// never call powershell.exe here\nconst x = 1;", description: "fix the thing" }),
        }],
      },
    },
  });
  const list = ledger.list("A");
  assert.equal(list.length, 1, "the interval is still created so timing stays honest");
  assert.deepEqual(list[0].exeHints, [], "run_code must mint NO hints");
  assert.match(list[0].command, /fix the thing/, "the description still labels the interval");
});

test("an execution tool command still seeds hints", () => {
  const { ledger } = makeLedger();
  ledger.onSessionEvent({ id: "A" }, {
    type: "assistant/message",
    data: {
      message: {
        content: [{
          type: "tool-call",
          id: "call-bash-1",
          name: "ops_bash",
          arguments: JSON.stringify({ command: "D:\\tools\\setup.exe /S" }),
        }],
      },
    },
  });
  const list = ledger.list("A");
  assert.equal(list.length, 1);
  assert.ok(list[0].exeHints.includes("setup.exe"), JSON.stringify(list[0].exeHints));
});

test("tool/result closes the tool-call interval", () => {
  const { ledger } = makeLedger();
  ledger.onSessionEvent({ id: "A" }, {
    type: "assistant/message",
    data: { message: { content: [{ type: "tool-call", id: "call-read-1", name: "read", arguments: JSON.stringify({ file_path: "x" }) }] } },
  });
  assert.equal(ledger.list("A").length, 1);
  assert.equal(ledger.list("A")[0].endMs, null, "open right after the call starts");
  ledger.onSessionEvent({ id: "A" }, {
    type: "tool/result",
    time: Date.now() + 5_000,
    data: { source: { kind: "tool", callId: "call-read-1" }, message: { toolCallId: "call-read-1" } },
  });
  assert.notEqual(ledger.list("A")[0].endMs, null, "tool/result must close the interval");
});

test("a long-lived process is attributed by the dialog-seen anchor", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "Start-Sleep 5", 100_000, 110_000);
  const a = makeAttributor(ledger);
  // process born long before the command (5000), dialog seen while it ran (105000)
  const d = a.receive(win("0xE1", { exe: "C:\\x\\unknown.exe", procCreateMs: 5_000, firstSeenMs: 105_000 }), 105_000);
  assert.equal(d.level, "medium");
  assert.equal(d.sessionId, "A");
  assert.match(d.evidence, /出现时刻/, "evidence must name the dialog-seen anchor: " + d.evidence);
});

test("proc-create anchor is still preferred when it is the one covering", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", "npm run x", 100_000, 110_000);
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xE2", { exe: "C:\\x\\unknown.exe", procCreateMs: 105_000, firstSeenMs: 500_000 }), 105_000);
  assert.equal(d.level, "medium");
  assert.match(d.evidence, /进程创建时刻/, "evidence must name the proc-create anchor: " + d.evidence);
});


test("an interceptor dialog is attributed by its session-carrying processes", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  // Firewall consent card: the window belongs to PickerHost.exe (the
  // interceptor), so the exe hint can never match. The blocked program and
  // the command chain carry DSH_SESSION_ID -> one session -> strong.
  const d = a.receive(win("0xF1", {
    exe: "C:\\Windows\\System32\\PickerHost.exe",
    cls: "Shell_SystemDialogProxy",
    kind: "system-consent",
    interceptor: true,
    sessionProcs: [
      { pid: 100, exe: "bash.exe", createMs: 1, sessionId: "A" },
      { pid: 101, exe: "node.exe", createMs: 2, sessionId: "A" },
    ],
  }), 50_000);
  assert.equal(d.level, "strong");
  assert.equal(d.sessionId, "A");
  assert.equal(d.action, "inject-strong");
  assert.match(d.evidence, /拦截类弹窗/);
});

test("an interceptor dialog with several sessions stays undecided", () => {
  const { ledger } = makeLedger();
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xF2", {
    exe: "C:\\Program Files\\Huorong\\HipsTray.exe",
    interceptor: true,
    sessionProcs: [
      { pid: 200, exe: "node.exe", createMs: 1, sessionId: "A" },
      { pid: 201, exe: "python.exe", createMs: 2, sessionId: "B" },
    ],
  }), 50_000);
  assert.equal(d.level, "medium", "two sessions must not be guessed");
  assert.equal(d.action, "pool");
});

test("an ordinary dialog is unaffected by the interceptor branch", () => {
  const { ledger, job } = makeLedger();
  job("A", "j1", ".\\setup_x64.exe /S", 10_000, 20_000);
  const a = makeAttributor(ledger);
  const d = a.receive(win("0xF3", { exe: "C:\\dl\\setup_x64.exe", procCreateMs: 15_000, firstSeenMs: 16_000 }), 16_000);
  assert.equal(d.action, "inject-strong");
});


// ---------------------------------------------------------------- report ---

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.error(`\n--- ${f.name}`);
    console.error(f.error?.stack || f.error);
  }
  process.exit(1);
}
