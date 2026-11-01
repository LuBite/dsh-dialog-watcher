/**
 * dsh-dialog-watcher — attribution engine (Phase2 方案 §4.3, FR2.1/2.2/2.2b).
 *
 * Input: one probe "window" event. Output: a decision —
 *   { action, sessionId?, level, evidence, template, pair? }
 *     action: "inject-strong" | "inject-medium" | "pool" | "ignore"
 *
 * Levels (FR2.1):
 *   strong — binding hit / exe-hint + process-time window / ledger owner /
 *            SmartScreen app field match  -> inject directly
 *   medium — only the process-creation time falls into a command window, or
 *            several sessions hit at once  -> two-command/two-dialog state
 *            machine; inject (tentative wording) only after a full pairing
 *   weak   — only temporal proximity            -> pool, never inject
 *   none   — nothing                            -> drop (debug logs only)
 *
 * The two-command/two-dialog machine (FR2.2, user-ratified v1.1):
 *   C1 -> E1 -> C2 -> E2, E1/E2 same program identity, each inside its own
 *   command window, C1 != C2, C2 started after E1 appeared, different hwnds,
 *   same candidate session — plus the five mutexes of FR2.2b.
 *
 * The class is deterministic given injected config + a now() function, so
 * test/cases.js exercises the state machine without DSH.
 */

const MUTEX = {
  PAIRED_ALREADY: "b-already-paired",
  RETRY_CHAIN: "c-same-callid-retry-chain",
  FLOOD: "d-3-in-5min",
  SESSION_UNSTABLE: "e-session-not-unique",
};

export { MUTEX };

function baseName(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function programIdOf(ev) {
  if (ev.smartScreenApp) return String(ev.smartScreenApp).toLowerCase();
  const exe = String(ev.exe || "");
  if (exe && !exe.startsWith("OPEN_FAIL") && !exe.startsWith("QUERY_FAIL")) return exe.toLowerCase();
  if (ev.proc) return `proc:${String(ev.proc).toLowerCase()}`;
  return `title:${String(ev.title || "").toLowerCase()}`;
}

export class Attributor {
  /**
   * @param opts.ledger    Ledger instance
   * @param opts.config    resolved config (thresholds)
   * @param opts.bindings  programId -> {sessionId} map accessor (fn)
   * @param opts.now       clock (defaults to Date.now)
   */
  constructor(opts) {
    this.ledger = opts.ledger;
    this.config = opts.config || {};
    this.bindingsOf = opts.bindings || (() => ({}));
    this.now = opts.now || (() => Date.now());

    /** hwnd -> { ev, at } every candidate window currently alive */
    this.windows = new Map();
    /** hwnd -> { sessionId, at } windows this plugin already injected for */
    this.injectedWindows = new Map();
    /** programId -> [ms] sightings (5-minute flood detection, mutex d) */
    this.programSeen = new Map();
    /** sessionId -> [ms] injected notices (throttle) */
    this.injectTimes = new Map();
    /** hwnd -> pending medium-evidence entry (state machine) */
    this.pending = new Map();
    /** hwnd -> ms when consumed by a pairing (mutex b) */
    this.paired = new Map();
    /** hwnds whose decision was logged (non-ignore) — gates `gone` records */
    this.loggedWindows = new Set();
    /** unattributed/pooled events for the UI (bounded) */
    this.pool = [];
    /** last decisions for the UI */
    this.recent = [];
  }

  cfg(key, dflt) {
    const v = this.config[key];
    return v === undefined ? dflt : v;
  }

  /** Does one specific interval's [start-before, end+after] window cover ms? */
  intervalCovers(iv, ms) {
    if (!iv) return false;
    const b = this.cfg("timeWindowBeforeMs", 2_000);
    const a = this.cfg("timeWindowAfterMs", 10_000);
    const end = iv.endMs ?? Number.MAX_SAFE_INTEGER;
    return ms >= iv.startMs - b && ms <= end + a;
  }

  /** Observe one probe window event; returns a decision record. */
  receive(ev, now = this.now()) {
    if (!ev || !ev.hwnd) return { action: "ignore", reason: "bad-event" };
    const hwnd = ev.hwnd;
    this.windows.set(hwnd, { ev, at: now });
    const pid = programIdOf(ev);
    const seen = this.programSeen.get(pid) || [];
    seen.push(now);
    const fiveMin = seen.filter((t) => now - t <= 300_000);
    this.programSeen.set(pid, fiveMin);

    const verdict = this.classify(ev, now);
    let decision;

    if (verdict.level === "strong") {
      decision = this.onStrong(ev, verdict, now);
    } else if (verdict.level === "medium") {
      decision = this.onMedium(ev, verdict, now);
    } else if (verdict.level === "weak") {
      decision = { action: "pool", level: "weak", evidence: verdict.evidence, sessionId: verdict.sessionIds[0] || null };
      this.pushPool(ev, verdict, decision, now);
    } else {
      decision = { action: "ignore", level: "none", evidence: verdict.evidence };
    }

    // Third acceptance 2.2: the events log only writes a `window` record for
    // non-ignored decisions, so a `gone` record for an ignored hwnd would be
    // an orphan line. Remember which windows were actually logged.
    if (decision.action && decision.action !== "ignore") this.loggedWindows.add(hwnd);

    this.pushRecent(ev, verdict, decision, now);
    return { ...decision, level: verdict.level, verdict };
  }

  /**
   * Evidence classification. Returns
   *   { level, sessionIds: [..], interval?, evidence: string, how }
   */
  classify(ev, now) {
    const programId = programIdOf(ev);
    // (0) manual binding (FR2.5) — strongest of all. The UI may have pinned
    // any of the identity forms, so try them all.
    const bindings = this.bindingsOf();
    const bindKeys = [
      programId,
      String(ev.exe || "").toLowerCase(),
      baseName(String(ev.exe || "")).toLowerCase(),
      String(ev.smartScreenApp || "").toLowerCase(),
    ].filter(Boolean);
    let bound = null;
    for (const k of bindKeys) {
      const b = bindings[k];
      if (b && b.sessionId) {
        bound = b;
        break;
      }
    }
    if (bound) {
      return {
        level: "strong",
        sessionIds: [bound.sessionId],
        evidence: `程序标识「${programId}」已被人工绑定到该会话`,
        how: "binding",
        sessionId: bound.sessionId,
      };
    }

    const exeBase = baseName(String(ev.exe || "")).toLowerCase();
    // (0) An interceptor dialog (firewall / UAC / SmartScreen / AV) owns its
    //     own window, so `ev.exe` is the INTERCEPTOR and can never match a
    //     command hint. The probe therefore also reports the processes that
    //     carry a DSH_SESSION_ID; if they agree on exactly one session, that
    //     session caused this dialog.
    if (ev.interceptor && Array.isArray(ev.sessionProcs) && ev.sessionProcs.length > 0) {
      const sids = [...new Set(
        ev.sessionProcs
          .map((x) => (x && typeof x.sessionId === "string" ? x.sessionId.replace(/^session-/, "") : ""))
          .filter(Boolean)
      )];
      if (sids.length === 1) {
        return {
          level: "strong",
          sessionIds: sids,
          sessionId: sids[0],
          evidence: `拦截类弹窗（宿主进程 ${baseName(String(ev.exe || "")) || "未知"}），被拦截程序一侧的进程带会话标记，唯一指向该会话`,
          how: "interceptor-session",
          diag: {
            exeBase,
            interceptor: true,
            sessionProcCount: ev.sessionProcs.length,
            sessionProcs: ev.sessionProcs.slice(0, 6).map((x) => ({ pid: x.pid, exe: x.exe })),
          },
        };
      }
      if (sids.length > 1) {
        return {
          level: "medium",
          sessionIds: sids,
          evidence: `拦截类弹窗：${sids.length} 个会话都有相关进程，候选不唯一`,
          how: "interceptor-ambiguous",
          diag: { exeBase, interceptor: true, sessionCount: sids.length },
        };
      }
    }

    const beforeMs = this.cfg("timeWindowBeforeMs", 2_000);
    const afterMs = this.cfg("timeWindowAfterMs", 10_000);

    // (1) SmartScreen "App:" field match (H3) — strong.
    if (ev.smartScreenApp) {
      const appBase = baseName(String(ev.smartScreenApp)).toLowerCase();
      const hits = this.ledger.hintHits(null, [appBase, String(ev.smartScreenApp).toLowerCase()]);
      const timed = hits.filter(
        (h) =>
          this.intervalCovers(h.interval, ev.firstSeenMs) ||
          this.intervalCovers(h.interval, ev.procCreateMs)
      );
      if (timed.length === 1) {
        const h = timed[0];
        return {
          level: "strong",
          sessionIds: [h.sessionId],
          sessionId: h.sessionId,
          interval: h.interval,
          evidence: `SmartScreen「应用」字段「${ev.smartScreenApp}」与该会话命令中的文件名精确匹配，且时间窗吻合`,
          how: "smartscreen-app",
        };
      }
      if (timed.length > 1) {
        return {
          level: "medium",
          sessionIds: timed.map((h) => h.sessionId),
          evidence: `SmartScreen「应用」字段命中 ${timed.length} 个会话的命令线索，候选不唯一`,
          how: "smartscreen-ambiguous",
        };
      }
    }

    // (2) exe hint + process creation time (H1) — strong.
    if (ev.exe && !String(ev.exe).startsWith("OPEN_FAIL") && !String(ev.exe).startsWith("QUERY_FAIL")) {
      const hintHits = this.ledger.hintHits(String(ev.exe).toLowerCase());
      // The hint-hit interval ITSELF must cover the process/first-seen time —
      // not just any interval of that session (that would bridge unrelated
      // commands and inflate weak hints into strong ones).
      const covering = hintHits.filter(
        (h) =>
          ev.procCreateMs === null ||
          ev.procCreateMs === undefined ||
          this.intervalCovers(h.interval, ev.procCreateMs) ||
          this.intervalCovers(h.interval, ev.firstSeenMs)
      );
      // hintHits now returns every matching interval per session (second
      // acceptance 2.2); one session may therefore appear several times.
      // Collapse to the session's CLOSEST covering interval so "many hits in
      // one session" never masquerades as "ambiguous across sessions".
      const bySession = new Map();
      for (const h of covering) {
        const prev = bySession.get(h.sessionId);
        if (!prev || h.interval.startMs > prev.interval.startMs) bySession.set(h.sessionId, h);
      }
      const usable = [...bySession.values()];
      if (usable.length === 1) {
        const h = usable[0];
        return {
          level: "strong",
          sessionIds: [h.sessionId],
          sessionId: h.sessionId,
          interval: h.interval,
          evidence: `窗口进程 ${baseName(String(ev.exe))} 由该会话的命令「${truncate(h.interval.command, 60)}」带起（命令线索命中且时间窗吻合）`,
          how: "exe-hint+time",
        };
      }
      if (usable.length > 1) {
        return {
          level: "medium",
          sessionIds: usable.map((h) => h.sessionId),
          evidence: `exe 命中 ${usable.length} 个会话的命令线索，候选会话不唯一`,
          how: "exe-ambiguous",
        };
      }
      // (3) owner chain into a ledgered command (H2) — strong.
      const ownerBase = baseName(String(ev.ownerExe || "")).toLowerCase();
      if (ownerBase) {
        const ownerHits = this.ledger.ledgerExeHits(ownerBase);
        if (ownerHits.length === 1) {
          const h = ownerHits[0];
          return {
            level: "strong",
            sessionIds: [h.sessionId],
            sessionId: h.sessionId,
            interval: h.interval,
            evidence: `弹窗的 owner 进程（${ownerBase}）属于该会话的账本命令`,
            how: "owner-chain",
          };
        }
      }
      // (4) medium M1: process born inside a command window, exe not hinted.
      const timedHits = [];
      for (const sid of this.ledger.allSessionIds()) {
        // Try BOTH anchors. Falling back only when the create time is MISSING
        // is not enough: a long-lived process always HAS one (hours old, perfectly
        // valid), so the dialog-seen time would never get a chance and every
        // host-owned dialog would fall through to weak. Rule (2) works the same
        // way and needs no such caveat.
        const byProc = ev.procCreateMs == null
          ? null
          : this.ledger.closestCovering(sid, ev.procCreateMs, beforeMs, afterMs);
        const bySeen = ev.firstSeenMs == null
          ? null
          : this.ledger.closestCovering(sid, ev.firstSeenMs, beforeMs, afterMs);
        const iv = byProc || bySeen;
        if (iv) timedHits.push({ sessionId: sid, interval: iv, anchor: byProc ? "proc-create" : "dialog-seen" });
      }
      const uniq = new Map(timedHits.map((h) => [h.sessionId, h]));
      if (uniq.size === 1) {
        const h = [...uniq.values()][0];
        return {
          level: "medium",
          sessionIds: [h.sessionId],
          sessionId: h.sessionId,
          interval: h.interval,
          evidence: `弹窗${h.anchor === "dialog-seen" ? "出现时刻" : "进程创建时刻"}落在该会话命令「${truncate(h.interval.command, 60)}」的执行区间内（仅时间线索）`,
          how: "time-window",
          // Ledger diagnostics for the events log (NOT part of the injected
          // text): shows why the hint path did not hit. First-acceptance
          // P2-1 had to be diagnosed blind; this ends that.
          diag: {
            exeBase,
            anchor: h.anchor,
            hintHitCount: hintHits.length,
            coveringCount: covering.length,
            hitHints: (hintHits[0]?.interval?.exeHints || []).slice(0, 6),
            coveringHints: (h.interval.exeHints || []).slice(0, 6),
          },
        };
      }
      if (uniq.size > 1) {
        return {
          level: "medium",
          sessionIds: [...uniq.keys()],
          evidence: `时间窗命中 ${uniq.size} 个会话，候选不唯一`,
          how: "time-ambiguous",
        };
      }
      // (5) weak: recent activity only.
      const weakMs = this.cfg("weakWindowMs", 90_000);
      const recent = this.ledger
        .allSessionIds()
        .filter((sid) => this.ledger.recentlyActive(sid, ev.firstSeenMs, weakMs));
      if (recent.length > 0) {
        return {
          level: "weak",
          sessionIds: recent,
          evidence: `仅时间接近（会话 ${weakMs / 1000}s 内有活动），无进程/文本证据`,
          how: "time-close",
        };
      }
      return { level: "none", sessionIds: [], evidence: "无任何会话线索" };
    }

    // No readable exe at all: weak if any session was recently active.
    const weakMs = this.cfg("weakWindowMs", 90_000);
    const recent = this.ledger
      .allSessionIds()
      .filter((sid) => this.ledger.recentlyActive(sid, ev.firstSeenMs, weakMs));
    if (recent.length > 0) {
      return {
        level: "weak",
        sessionIds: recent,
        evidence: "窗口进程信息不可读，仅会话时间接近",
        how: "time-close",
      };
    }
    return { level: "none", sessionIds: [], evidence: "无任何会话线索" };
  }

  onStrong(ev, verdict, now) {
    const sid = verdict.sessionId || verdict.sessionIds[0];
    // Strict idempotency: the probe re-reports an unchanged window only once
    // per daemon life, but after a probe respawn the Known set restarts and
    // the same dialog comes back — never inject twice for one window.
    if (this.injectedWindows.has(ev.hwnd)) {
      return { action: "pool", level: "strong", sessionId: sid, evidence: verdict.evidence, reason: "already-notified" };
    }
    const throttle = this.throttleCheck(sid, now);
    if (!throttle.ok) {
      return { action: "pool", level: "strong", sessionId: sid, evidence: verdict.evidence, reason: throttle.reason };
    }
    this.markInjected(sid, now);
    this.injectedWindows.set(ev.hwnd, { sessionId: sid, at: now });
    return {
      action: "inject-strong",
      sessionId: sid,
      evidence: verdict.evidence,
      how: verdict.how,
      kind: ev.kind,
    };
  }

  onMedium(ev, verdict, now) {
    const programId = programIdOf(ev);
    // Mutex (e): candidate session must be exactly one and stay one.
    if (verdict.sessionIds.length !== 1) {
      const d = { action: "pool", level: "medium", sessionId: null, evidence: verdict.evidence, reason: MUTEX.SESSION_UNSTABLE };
      this.pushPool(ev, verdict, d, now);
      return d;
    }
    const sid = verdict.sessionIds[0];


    // Try to pair with a pending E1 of the same program in the same session.
    const e2 = { ev, verdict, sid, now };
    for (const [hwnd1, e1] of this.pending) {
      if (hwnd1 === ev.hwnd) continue;
      if (e1.sid !== sid) continue;
      if (programIdOf(e1.ev) !== programId) continue;
      const pair = this.tryPair(e1, e2, now);
      if (pair.ok) {
        // Mutex checks passed — consume both (mutex b: one pairing each).
        this.pending.delete(hwnd1);
        this.paired.set(hwnd1, now);
        this.paired.set(ev.hwnd, now);
        const throttle = this.throttleCheck(sid, now);
        if (!throttle.ok) {
          const d = { action: "pool", level: "medium", sessionId: sid, evidence: verdict.evidence, reason: throttle.reason, pair: pair.info };
          this.pushPool(ev, verdict, d, now);
          return d;
        }
        this.markInjected(sid, now);
        this.injectedWindows.set(hwnd1, { sessionId: sid, at: now });
        this.injectedWindows.set(ev.hwnd, { sessionId: sid, at: now });
        return {
          action: "inject-medium",
          sessionId: sid,
          evidence: verdict.evidence,
          how: verdict.how,
          kind: ev.kind,
          pair: pair.info,
          mainWindow: hwnd1,
        };
      }
      // Pairing rejected by a mutex: per FR2.2b both go to the pool.
      const d = {
        action: "pool",
        level: "medium",
        sessionId: sid,
        evidence: verdict.evidence,
        reason: pair.reason,
        pair: pair.info || null,
      };
      this.pushPool(e1.ev, e1.verdict, { action: "pool", level: "medium", reason: pair.reason }, now);
      this.pushPool(ev, verdict, d, now);
      this.pending.delete(hwnd1);
      return d;
    }

    // No E1 yet: E1 becomes pending; times out into the pool later.
    const timeoutMs = this.cfg("mediumTimeoutMs", 600_000);
    if (now - (ev.firstSeenMs || now) > timeoutMs) {
      const d = { action: "pool", level: "medium", sessionId: sid, evidence: verdict.evidence, reason: "pending-timeout" };
      this.pushPool(ev, verdict, d, now);
      return d;
    }
    this.pending.set(ev.hwnd, { ev, verdict, sid, firstSeenMs: ev.firstSeenMs || now, at: now });
    return { action: "pending", level: "medium", sessionId: sid, evidence: verdict.evidence };
  }

  /**
   * FR2.2 five conditions + FR2.2b five mutexes. Pure given the entries.
   * e1: {ev, verdict, sid, firstSeenMs}; e2: {ev, verdict, sid, now}
   */
  tryPair(e1, e2, now) {
    const info = {
      commandA: e1.verdict.interval?.command || "",
      commandB: e2.verdict.interval?.command || "",
    };
    // (1) same program identity — checked by the caller.
    // (2) each falls inside its own command window — verdict.interval exists.
    if (!e1.verdict.interval || !e2.verdict.interval) {
      return { ok: false, reason: "no-interval", info };
    }
    // (3) C1 != C2 and C2 started after E1 was first seen.
    const c1 = e1.verdict.interval;
    const c2 = e2.verdict.interval;
    const sameCommand = c1 === c2 || (c1.jobId && c1.jobId === c2.jobId);
    if (sameCommand) return { ok: false, reason: "same-command", info };
    if (c1.callId && c2.callId && c1.callId === c2.callId) {
      return { ok: false, reason: MUTEX.RETRY_CHAIN, info };
    }
    if (!(c2.startMs > (e1.firstSeenMs || 0))) {
      return { ok: false, reason: "c2-not-after-e1", info };
    }
    // (4) E1 != E2 (different hwnd) — caller guarantees.
    // Mutex (b): either side already paired.
    if (this.paired.has(e1.ev.hwnd) || this.paired.has(e2.ev.hwnd)) {
      return { ok: false, reason: MUTEX.PAIRED_ALREADY, info };
    }
    // Mutex (c) was handled via callId above (jobId equality covers the
    // registered-miss case; a retry reusing one tool-call id shares callId).
    // Mutex (d): same program 3+ times within 5 minutes.
    const pid = programIdOf(e1.ev);
    const seen = (this.programSeen.get(pid) || []).filter((t) => now - t <= 300_000);
    if (seen.length >= 3) return { ok: false, reason: MUTEX.FLOOD, info };
    // Mutex (e): candidate session unique & stable — caller checked length.
    return { ok: true, info };
  }

  /** Medium entries that never got a partner flow into the pool. */
  tick(now = this.now()) {
    const timeoutMs = this.cfg("mediumTimeoutMs", 600_000);
    for (const [hwnd, e1] of [...this.pending]) {
      if (now - e1.firstSeenMs > timeoutMs) {
        this.pending.delete(hwnd);
        this.pushPool(e1.ev, e1.verdict, { action: "pool", level: "medium", reason: "pending-timeout" }, now);
      }
    }
    this.ledger.prune(now);
    // Keep memory bounded: entries older than 2h can never matter again
    // (dialogs outlive their relevance, probe restarts re-report fresh).
    const staleMs = 2 * 3_600_000;
    for (const [hwnd, rec] of this.windows) if (now - rec.at > staleMs) this.windows.delete(hwnd);
    for (const [hwnd, rec] of this.injectedWindows) if (now - rec.at > staleMs) this.injectedWindows.delete(hwnd);
    for (const [hwnd, at] of this.paired) if (now - at > staleMs) this.paired.delete(hwnd);
    for (const [pid, times] of this.programSeen) {
      const kept = times.filter((t) => now - t <= 300_000);
      if (kept.length === 0) this.programSeen.delete(pid);
      else this.programSeen.set(pid, kept);
    }
    for (const [sid, times] of this.injectTimes) {
      const kept = times.filter((t) => now - t <= 120_000);
      if (kept.length === 0) this.injectTimes.delete(sid);
      else this.injectTimes.set(sid, kept);
    }
    if (this.pool.length > 200) this.pool.splice(0, this.pool.length - 200);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
  }

  /** The probe reported the window is gone. */
  gone(hwnd, now = this.now()) {
    const rec = this.windows.get(hwnd);
    this.windows.delete(hwnd);
    this.pending.delete(hwnd);
    const inj = this.injectedWindows.get(hwnd);
    this.injectedWindows.delete(hwnd);
    if (!rec) return null;
    return { ev: rec.ev, injectedSessionId: inj?.sessionId || null };
  }

  throttleCheck(sid, now) {
    const windowMs = this.cfg("throttleWindowMs", 60_000);
    const max = this.cfg("throttleMax", 3);
    const times = (this.injectTimes.get(sid) || []).filter((t) => now - t <= windowMs);
    this.injectTimes.set(sid, times);
    if (times.length >= max) {
      return { ok: false, reason: `throttled-${times.length}-in-${windowMs}ms` };
    }
    return { ok: true };
  }

  markInjected(sid, now) {
    const times = this.injectTimes.get(sid) || [];
    times.push(now);
    this.injectTimes.set(sid, times);
  }

  pushPool(ev, verdict, decision, now) {
    // programIdOf is the canonical binding key: the panel pins exactly this
    // string, and classify() looks bindings up under every identity form.
    this.pool.push({
      at: now,
      hwnd: ev.hwnd,
      title: ev.title || "",
      program: programIdOf(ev),
      level: verdict.level,
      candidateSessions: verdict.sessionIds || [],
      why: decision.reason || decision.evidence || verdict.evidence,
      kind: ev.kind,
    });
  }

  pushRecent(ev, verdict, decision, now) {
    this.recent.push({
      at: now,
      hwnd: ev.hwnd,
      title: ev.title || "",
      program: programIdOf(ev),
      level: verdict.level,
      action: decision.action,
      sessionId: decision.sessionId || null,
      evidence: decision.evidence || verdict.evidence,
      reason: decision.reason || null,
      kind: ev.kind,
    });
  }

  /** Does this hwnd belong to the windows the probe reported alive? */
  knownWindow(hwnd) {
    return this.windows.get(hwnd) || null;
  }
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
