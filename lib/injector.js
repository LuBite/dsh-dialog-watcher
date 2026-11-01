/**
 * dsh-dialog-watcher — injector (Phase2 方案 §4.4, FR3).
 *
 * One path only: agent.steer(createUserMessage({ content, source })). steer
 * wakes idle sessions and steps into the next model step of running ones —
 * D2 decided "always wake". The source kind MUST be `plugin:dialog-watcher`
 * (session format v4 rejects kind === 'plugin' outright and fails the whole
 * run); form:'notice' + summary render as the host's one-line context-inject
 * row, and we degrade to bare {kind} if the host refuses the extra fields.
 *
 * Failures (archived session, writer lock, subagent targets) are recorded
 * and swallowed — FR3.5: silent, never crash the watcher.
 *
 * First-acceptance P0-1 lesson: cordis throws "cannot get property X without
 * inject" when plugin code READS an undeclared host service off ctx, and
 * optional chaining does not protect (the proxy throws on the property read
 * itself). This class therefore never touches ctx: it receives plain
 * references resolved by index.js through nested ctx.inject, and treats a
 * missing reference as "injection unavailable" (quiet degrade, NFR1).
 */

import { tryRequire } from "./store.js";

const dshLlm = tryRequire("@deepseek-ai/dsh-llm");
const createUserMessage = dshLlm?.createUserMessage;

export const PLUGIN_KIND = "plugin:dialog-watcher";

export class Injector {
  /**
   * @param opts.services {agents, sessionController} plain references or null
   * @param opts.store    Store instance for the decision log
   * @param opts.log      warn-style logger
   */
  constructor({ services, store, log } = {}) {
    this.services = services || { agents: null, sessionController: null };
    this.store = store;
    this.log = log || (() => {});
    this.degradedSource = false; // set once form/summary got refused
  }

  /**
   * Subagent sessions are excluded (FR3.5 / 需求定义 §3.2): summaries carry
   * origin 'subagent' or a parentSessionId. Returns false when the session
   * table is unavailable — availability is unknown, not "subagent".
   */
  isSubagentSession(sid) {
    try {
      const sc = this.services.sessionController;
      if (!sc || typeof sc.list !== "function") return false;
      const list = sc.list({}, AbortSignal.timeout(3000));
      const items = list?.items || list || [];
      const s = items.find?.((x) => x.sessionId === sid || x.sessionId === `session-${sid}`);
      if (!s) return false;
      return s.origin === "subagent" || Boolean(s.parentSessionId);
    } catch {
      return false;
    }
  }

  /**
   * Inject one notice. Returns {ok, reason?}. Records the outcome.
   * Async for future-proofing; the current path is fully synchronous.
   */
  async inject(sessionId, text, summary, meta = {}) {
    try {
      if (!sessionId) return { ok: false, reason: "no-session" };
      if (typeof createUserMessage !== "function") {
        this.log("injector: createUserMessage unavailable — DSH llm package not resolvable");
        return { ok: false, reason: "llm-api-unavailable" };
      }
      if (this.isSubagentSession(sessionId)) {
        this.record(sessionId, text, summary, meta, false, "subagent-skipped");
        return { ok: false, reason: "subagent-skipped" };
      }
      const agents = this.services.agents;
      if (!agents || typeof agents.get !== "function") {
        // agents service not resolved yet (or absent in this profile):
        // degrade quietly instead of throwing (NFR1).
        this.record(sessionId, text, summary, meta, false, "agents-service-unavailable");
        return { ok: false, reason: "agents-service-unavailable" };
      }
      let agent = null;
      try {
        agent = agents.get(sessionId) || agents.get(`session-${sessionId}`) || null;
      } catch (error) {
        this.log(`injector: agents.get failed: ${error?.message || error}`);
      }
      if (!agent || typeof agent.steer !== "function") {
        this.record(sessionId, text, summary, meta, false, "agent-not-live");
        return { ok: false, reason: "agent-not-live" };
      }

      const content = [{ type: "text", text }];
      const attempts = this.degradedSource
        ? [{ kind: PLUGIN_KIND }]
        : [{ kind: PLUGIN_KIND, form: "notice", summary }, { kind: PLUGIN_KIND }];

      let lastError = null;
      for (const source of attempts) {
        try {
          const msg = createUserMessage({ content, source });
          agent.steer(msg);
          if (source === attempts[attempts.length - 1] && attempts.length > 1) {
            this.degradedSource = true; // rich source refused; stay minimal
            this.log("injector: form/summary source refused, degraded to bare kind");
          }
          this.record(sessionId, text, summary, meta, true, null);
          return { ok: true };
        } catch (error) {
          lastError = error;
          this.log(`injector: steer failed (${source.form || "bare"}): ${error?.message || error}`);
        }
      }
      this.record(sessionId, text, summary, meta, false, String(lastError?.message || lastError || "steer-failed"));
      return { ok: false, reason: "steer-failed" };
    } catch (error) {
      // Absolute outer guard: injection problems never propagate (NFR1).
      try {
        this.log(`injector: inject failed hard: ${error?.stack || error?.message || error}`);
        this.record(sessionId, text, summary, meta, false, String(error?.message || error));
      } catch {
        /* nothing more we can do */
      }
      return { ok: false, reason: "internal" };
    }
  }

  record(sessionId, text, summary, meta, ok, error) {
    try {
      this.store?.appendEvent({
        ev: "inject",
        sessionId,
        summary,
        ok,
        error,
        hwnd: meta.hwnd,
        level: meta.level,
        action: meta.action,
        textHead: String(text || "").slice(0, 400),
      });
    } catch {
      /* logging never breaks injection */
    }
  }
}
