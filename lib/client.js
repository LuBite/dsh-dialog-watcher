// dsh-dialog-watcher client bundle (browser half).
//
// Module format: the shell's ClientModuleSystem executes this script once and
// only materializes the factory later, handing it a synchronous require —
// same shape as dsh-tag-toggle / dsh-pet. The exports must be the cordis
// client-plugin entry { name, inject, apply }.
//
// v2 — floating panel (user-ratified design):
//   The switches move OUT of the session header slot into the shell-level
//   `shell.overlay` slot (the same slot the dsh-pet desktop pet lives in),
//   so the panel is a GLOBAL floating widget: position:fixed, rendered once,
//   never re-mounted on session switches, visible on every page. Old
//   session-header registration is gone entirely.
//
//   Positioning: the first time ever (no saved position) the panel anchors
//   below the existing left-top plugin group when it can see one
//   (.dtt-bar = tag-toggle bar, else .dpi-launcher = the prompt button),
//   else falls back to the top-left corner (20, 40). The resolved position
//   — and every later drag — is persisted in localStorage (option A), so
//   afterwards the panel stays exactly where the user put it.
//
//   Dragging: a slim grip strip on top shows a drag glyph on hover
//   (cursor grab); pointer capture moves the panel, clamped to the viewport.
//
//   Theme: colors come from DSH's design tokens (--dsw-alias-*) like
//   dsh-pet's own panels, so light/dark follows the app automatically.

window.__ModuleLoader__.load({
  id: "dsh-dialog-watcher",
  factory: (require) => {
    var React = null;
    var ReactDOM = null;
    // Never let a missing module kill the factory: every step logs with the
    // [dsh-dialog-watcher] prefix so a missing panel can be diagnosed from
    // the DevTools console alone.
    try {
      React = require("react");
      console.info("[dsh-dialog-watcher] react loaded:", typeof React);
    } catch (e) {
      console.warn("[dsh-dialog-watcher] require react failed:", e);
    }
    try {
      ReactDOM = require("react-dom");
      console.info("[dsh-dialog-watcher] react-dom loaded:", typeof ReactDOM);
    } catch (e) {
      console.warn("[dsh-dialog-watcher] require react-dom failed:", e);
    }

    var exports = {};
    exports.name = "dsh-dialog-watcher";
    // NO service dependencies on purpose: the panel mounts itself into
    // document.body and talks to the host only via fetch. A declared client
    // service (like "slots") that never activates leaves the whole plugin
    // pending — apply never runs and nothing renders (a plausible cause of
    // the silent no-panel report).
    exports.inject = [];

    var API = "/dialog-watcher/api";
    var POS_KEY = "dsh-dialog-watcher.panel-pos";
    var SNAP_KEY = "dsh-dialog-watcher.snap";
    var ANCHOR_X_KEY = "dsh-dialog-watcher.anchor-x";

    function post(body) {
      return fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json();
        })
        .catch(function () {
          return null;
        });
    }

    function fmtTime(ms) {
      try {
        var d = new Date(ms);
        return (
          ("0" + d.getHours()).slice(-2) +
          ":" +
          ("0" + d.getMinutes()).slice(-2) +
          ":" +
          ("0" + d.getSeconds()).slice(-2)
        );
      } catch (e) {
        return "";
      }
    }

    var LEVEL_COLOR = {
      strong: "#1a7f37",
      medium: "#9a6700",
      weak: "#57606a",
      none: "#8b949e",
    };

    //#region styles
    // Colors ride on DSH design tokens (--dsw-alias-*, the same variables
    // dsh-pet panels use) so light/dark theme follows the app automatically;
    // the fallbacks keep the panel legible if a token is missing.
    var CSS = [
      ".dw-float{position:fixed;z-index:2147480000;display:flex;flex-direction:column;gap:4px;" +
        "padding:6px;border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.45));border-radius:var(--dsw-radius-md,10px);" +
        "background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);" +
        "box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.25));font-size:12px;visibility:hidden}",
      // The drag grip is a SEAMLESS 10px hot strip that touches the panel
      // top edge (5px above it + 5px over the panel's own padding) — no gap
      // means the :hover chain cannot break as the cursor crosses the
      // boundary (the previous floating strip had a 4px dead gap and the
      // hover died the moment the cursor left the panel). It takes no layout
      // space: toggling snap never shifts a glyph. The visible 5px plate
      // (framed background + two-line glyph) fades in on hover or drag;
      // when snap is on the grip is not rendered at all.
      ".dw-grip{position:absolute;left:0;right:0;top:-10px;height:10px;box-sizing:border-box;" +
        "display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none}",
      ".dw-grip-plate{width:100%;height:5px;box-sizing:border-box;" +
        "background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.45));" +
        "border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.12);display:flex;align-items:center;justify-content:center;" +
        "opacity:0;transition:opacity .15s}",
      ".dw-float:hover .dw-grip-plate,.dw-float.dw-dragging .dw-grip-plate{opacity:1}",
      ".dw-grip:active .dw-grip-plate{border-color:#1f6feb}",
      ".dw-grip-lines{width:26px;height:1px;border-top:1px solid var(--dsw-alias-label-tertiary,#8b949e);" +
        "border-bottom:1px solid var(--dsw-alias-label-tertiary,#8b949e);opacity:.85}",
      ".dw-grid{display:grid;grid-template-columns:auto 34px 34px;gap:4px 6px;align-items:center;white-space:nowrap}",
      ".dw-name{border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.45));border-radius:6px;" +
        "background:rgba(140,140,150,.06);color:inherit;font-size:12px;line-height:18px;padding:2px 10px;text-align:center}",
      ".dw-btn{border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.45));border-radius:6px;" +
        "background:transparent;color:inherit;font-size:12px;line-height:18px;padding:2px 0;text-align:center;cursor:pointer}",
      ".dw-btn:hover{background:rgba(140,140,150,.18)}",
      ".dw-btn[aria-disabled='true']{opacity:.4;cursor:not-allowed}",
      ".dw-btn[data-active='true']{border-color:#1f6feb;color:#0969da;font-weight:600;background:rgba(31,111,235,.08)}",
      ".dw-btn[data-dead='true']{opacity:.45;cursor:default}",
      ".dw-wide{grid-column:2 / span 2}",
      ".dw-offline{grid-column:1 / span 3;color:#b35900;font-size:11px;line-height:16px;padding:0 2px;white-space:normal}",
      ".dw-panel{position:absolute;top:calc(100% + 6px);left:-1px;width:440px;max-height:380px;overflow:auto;" +
        "border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.45));border-radius:var(--dsw-radius-md,10px);padding:10px 12px;" +
        "background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);" +
        "box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.25))}",
      ".dw-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px dashed rgba(140,140,150,.25)}",
      ".dw-row:last-child{border-bottom:0}",
      ".dw-t{flex:none;width:52px;color:#8b949e}",
      ".dw-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dw-sub{color:#8b949e}",
      ".dw-lv{flex:none;font-weight:600}",
      ".dw-sec{font-weight:600;margin:8px 0 2px}",
      ".dw-bind{flex:none;border:1px solid var(--dsw-alias-border-l1,rgba(140,140,150,.5));border-radius:4px;padding:0 6px;cursor:pointer}",
      ".dw-empty{color:#8b949e;padding:2px 0}",
      ".dw-panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-weight:600}",
      ".dw-close{cursor:pointer;color:#0969da;border:1px solid rgba(31,111,235,.5);border-radius:4px;" +
        "padding:0 8px;font-weight:400;line-height:18px}",
      ".dw-close:hover{background:rgba(31,111,235,.08)}",
    ].join("");
    //#endregion

    function clampPos(p, el) {
      var w = el ? el.offsetWidth : 200;
      var maxX = window.innerWidth - w - 8;
      var maxY = window.innerHeight - 36; // keep at least the grip reachable
      return {
        x: Math.min(Math.max(p.x, 8), Math.max(8, maxX)),
        y: Math.min(Math.max(p.y, 8), Math.max(8, maxY)),
      };
    }

    //#region floating panel app
    function ShellApp() {
      var st = React.useState(null);
      var state = st[0];
      var setState = st[1];
      var panelOpen = React.useState(false);
      var open = panelOpen[0];
      var setOpen = panelOpen[1];
      var bindDraft = React.useState({});
      var draft = bindDraft[0];
      var setDraft = bindDraft[1];
      // pos === null until the initial position is resolved: the panel is
      // rendered hidden so it can be measured, never seen misplaced.
      var posState = React.useState(null);
      var pos = posState[0];
      var setPos = posState[1];
      var posRef = React.useRef(null);
      var rootRef = React.useRef(null);
      var gripRef = React.useRef(null);
      // Snap switch (user-ratified): on = stick below fixed plugin groups
      // (drag disabled); off = free drag, position stays where dropped.
      var snapState = React.useState(function () {
        try {
          return localStorage.getItem(SNAP_KEY) === "off" ? "off" : "on";
        } catch (e) {
          return "on";
        }
      });
      var snap = snapState[0];
      var setSnap = snapState[1];

      var refresh = React.useCallback(function () {
        post({ method: "state" }).then(function (s) {
          if (s && s.ok) setState(s);
        });
      }, []);

      React.useEffect(function () {
        refresh();
        var timer = window.setInterval(refresh, 1500);
        return function () {
          window.clearInterval(timer);
        };
      }, [refresh]);

      function realToggle(patch) {
        post(Object.assign({ method: "toggle" }, patch)).then(refresh);
      }

      function bind(programId, sessionId) {
        post({ method: "bind", programId: programId, sessionId: sessionId }).then(function () {
          setDraft({});
          refresh();
        });
      }

      function unbind(programId) {
        post({ method: "unbind", programId: programId }).then(refresh);
      }

      //#region position: snap switch + drag (user-ratified v3)
      /**
       * Compute the snap target (fixed-viewport coordinates):
       *   1. below the fixed plugin group (.dtt-bar / .dpi-launcher) — the
       *      anchor's left is remembered so the no-plugin case can reuse it;
       *   2. no plugin group -> top-left of the SESSION content area (right
       *      of the workspace sidebar, below the session header) — explicitly
       *      NOT the top-left of the whole window, which would cover the
       *      sidebar;
       *   3. outside a session page (no header) -> null (panel stays put).
       */
      function snapPosition() {
        var dtt = document.querySelector(".dtt-bar");
        var dpi = document.querySelector(".dpi-launcher");
        var anchor = dtt || dpi;
        if (anchor && typeof anchor.getBoundingClientRect === "function") {
          try {
            var r = anchor.getBoundingClientRect();
            if (r.bottom > 0 || r.top > 0) {
              try {
                localStorage.setItem(ANCHOR_X_KEY, String(Math.round(r.left)));
              } catch (e0) {
                /* best effort */
              }
              return { x: Math.max(8, r.left), y: Math.max(8, r.bottom + 10) };
            }
          } catch (e) {
            /* next tick */
          }
        }
        var memX = 0;
        try {
          memX = parseInt(localStorage.getItem(ANCHOR_X_KEY) || "0", 10) || 0;
        } catch (e1) {
          memX = 0;
        }
        var header = document.querySelector("header");
        if (!header) return null; // not a session page: keep current position
        var x = memX > 8 ? memX : 320;
        var y = Math.max(8, header.getBoundingClientRect().bottom + 6);
        return { x: x, y: y };
      }

      function persistPos(obj) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(obj));
        } catch (e) {
          /* best effort */
        }
      }

      function setSnapMode(mode) {
        try {
          localStorage.setItem(SNAP_KEY, mode);
        } catch (e) {
          /* best effort */
        }
        setSnap(mode);
        if (mode === "on") {
          // Turning snap ON snaps immediately back to the anchored spot.
          var p = snapPosition();
          if (p) {
            var c = clampPos(p, rootRef.current);
            posRef.current = c;
            setPos(c);
            persistPos(Object.assign({ src: "anchor" }, c));
          }
        }
        // off: position stays where it is; dragging becomes available.
      }

      // Initial position: saved position wins; otherwise resolve the snap
      // target (snap on -> src anchor, snap off -> src auto), with a
      // (320,160) session-area fallback after ~5s of no anchor.
      React.useEffect(function () {
        var saved = null;
        try {
          saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
        } catch (e) {
          saved = null;
        }
        if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
          var restored = clampPos(saved, rootRef.current);
          posRef.current = restored;
          setPos(restored);
          return undefined;
        }
        var snapNow = snap;
        var tries = 0;
        var t = window.setInterval(function () {
          tries += 1;
          var p = snapPosition();
          if (p) {
            var c = clampPos(p, rootRef.current);
            posRef.current = c;
            setPos(c);
            persistPos(Object.assign({ src: snapNow === "on" ? "anchor" : "auto" }, c));
            window.clearInterval(t);
          } else if (tries > 40) {
            var c2 = clampPos({ x: 320, y: 160 }, rootRef.current);
            posRef.current = c2;
            setPos(c2);
            persistPos(Object.assign({ src: "auto" }, c2));
            window.clearInterval(t);
          }
        }, 120);
        return function () {
          window.clearInterval(t);
        };
      }, []);

      // Snap follower (snap === on): re-align to the anchor every second.
      // The shell layout shifts during startup and between pages, so this is
      // continuous following, deliberately; it stops the moment snap is off.
      React.useEffect(function () {
        if (snap !== "on") return undefined;
        var w = window.setInterval(function () {
          var p = snapPosition();
          if (!p) return;
          var c = clampPos(p, rootRef.current);
          var cur = posRef.current;
          if (!cur || Math.abs(cur.x - c.x) > 1 || Math.abs(cur.y - c.y) > 1) {
            posRef.current = c;
            setPos(c);
            persistPos(Object.assign({ src: "anchor" }, c));
          }
        }, 1000);
        return function () {
          window.clearInterval(w);
        };
      }, [snap]);

      // Dragging (snap === off only): the grip is not rendered while snap is
      // on, so the handler is bound only in free-drag mode.
      React.useEffect(function () {
        if (snap !== "off") return undefined;
        var grip = gripRef.current;
        if (!grip) return undefined;
        var drag = null;
        function onDown(e) {
          if (e.button !== 0) return;
          var root = rootRef.current;
          if (!root) return;
          var r = root.getBoundingClientRect();
          drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          root.classList.add("dw-dragging");
          try {
            if (grip.setPointerCapture && e.pointerId !== undefined) grip.setPointerCapture(e.pointerId);
          } catch (e2) {
            /* capture is best effort */
          }
          e.preventDefault();
        }
        function onMove(e) {
          if (!drag) return;
          var p = clampPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, rootRef.current);
          posRef.current = p;
          setPos(p);
          e.preventDefault();
        }
        function onUp() {
          if (!drag) return;
          drag = null;
          rootRef.current && rootRef.current.classList.remove("dw-dragging");
          persistPos(Object.assign({ src: "drag" }, posRef.current));
        }
        grip.addEventListener("pointerdown", onDown);
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp);
        grip.addEventListener("pointercancel", onUp);
        return function () {
          grip.removeEventListener("pointerdown", onDown);
          grip.removeEventListener("pointermove", onMove);
          grip.removeEventListener("pointerup", onUp);
          grip.removeEventListener("pointercancel", onUp);
        };
      }, [snap]);
      //#endregion

      // Keep a saved position inside the viewport when the window shrinks.      }, []);
      //#endregion

      // Keep a saved position inside the viewport when the window shrinks.
      React.useEffect(function () {
        function onResize() {
          if (posRef.current) {
            var p = clampPos(posRef.current, rootRef.current);
            posRef.current = p;
            setPos(p);
          }
        }
        window.addEventListener("resize", onResize);
        return function () {
          window.removeEventListener("resize", onResize);
        };
      }, []);

      var connected = Boolean(state);
      var probeOn = connected && Boolean(state.probeOn);
      var clickOn = connected && Boolean(state.clickOn);

      // Framed name cell + 开/关 pair (the ratified three-column layout).
      function switchRow(name, onActive, offActive, disabled, titleBase, onFn, offFn, key) {
        var dead = !connected;
        return [
          React.createElement("span", { className: "dw-name", key: key + "-name" }, name),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dw-btn",
              "data-active": onActive && !dead ? "true" : "false",
              "data-dead": dead ? "true" : "false",
              "aria-disabled": disabled || dead ? "true" : "false",
              title: dead ? "未连接宿主 API，开关暂不可用" : titleBase + "：设为开",
              onClick: function () {
                if (!dead && !disabled) onFn();
              },
              key: key + "-on",
            },
            "开"
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dw-btn",
              "data-active": offActive && !dead ? "true" : "false",
              "data-dead": dead ? "true" : "false",
              "aria-disabled": disabled || dead ? "true" : "false",
              title: dead ? "未连接宿主 API，开关暂不可用" : titleBase + "：设为关",
              onClick: function () {
                if (!dead && !disabled) offFn();
              },
              key: key + "-off",
            },
            "关"
          ),
        ];
      }

      var cells = [];
      if (!connected) {
        cells.push(
          React.createElement(
            "span",
            { className: "dw-offline", key: "offline" },
            "⚠ 未连接宿主 API —— 开关暂不可用；请检查 DSH 日志中是否有 api-registered（弹窗监控路由注册记录）"
          )
        );
      }
      cells.push.apply(
        cells,
        switchRow(
          "弹窗监控",
          probeOn,
          !probeOn,
          false,
          "探测开关：关掉后探测器退出，不再检测任何弹窗",
          function () {
            realToggle({ probe: true });
          },
          function () {
            realToggle({ probe: false });
          },
          "probe"
        )
      );
      cells.push.apply(
        cells,
        switchRow(
          "允许代点",
          clickOn,
          !clickOn,
          !probeOn,
          "允许模型代点弹窗按钮（不抢前台）；系统安全询问卡片会用真实鼠标点击；探测关闭时不可用",
          function () {
            realToggle({ click: true });
          },
          function () {
            realToggle({ click: false });
          },
          "click"
        )
      );
      cells.push.apply(
        cells,
        switchRow(
          "吸附",
          snap === "on",
          snap === "off",
          false,
          "吸附：面板自动贴在固定插件组下方（拖动禁用）；关闭后可自由拖动摆放",
          function () {
            setSnapMode("on");
          },
          function () {
            setSnapMode("off");
          },
          "snap"
        )
      );
      cells.push(React.createElement("span", { className: "dw-name", key: "panel-name" }, "弹窗记录"));
      cells.push(
        React.createElement(
          "button",
          {
            type: "button",
            className: "dw-btn dw-wide",
            "data-active": open ? "true" : "false",
            title: "查看最近弹窗事件、未归属池与绑定表" + (state && state.pool && state.pool.length ? "（池中有 " + state.pool.length + " 条待查看）" : ""),
            onClick: function () {
              setOpen(!open);
            },
            key: "panel-btn",
          },
          open ? "收起" : "查看" + (state && state.pool && state.pool.length ? "（" + state.pool.length + "）" : "")
        )
      );

      var grid = React.createElement("div", { className: "dw-grid" }, cells);

      var recordPanel = null;
      if (open) {
        var rows = [];
        var recent = (state && state.recent) || [];
        for (var i = 0; i < recent.length; i++) {
          var r = recent[i];
          rows.push(
            React.createElement(
              "div",
              { className: "dw-row", key: "r" + i },
              React.createElement("span", { className: "dw-t" }, fmtTime(r.at)),
              React.createElement(
                "span",
                { className: "dw-lv", style: { color: LEVEL_COLOR[r.level] || "#57606a" } },
                r.level
              ),
              React.createElement(
                "span",
                { className: "dw-main" },
                (r.program || "?") + " — " + (r.title || r.kind || ""),
                React.createElement(
                  "span",
                  { className: "dw-sub" },
                  " · " + r.action + (r.sessionId ? " · " + String(r.sessionId).slice(0, 8) : "") + (r.reason ? " · " + r.reason : "")
                )
              )
            )
          );
        }
        var poolRows = [];
        var pool = (state && state.pool) || [];
        for (var j = 0; j < pool.length; j++) {
          (function (p) {
            var rowKey = String(p.hwnd || j);
            poolRows.push(
              React.createElement(
                "div",
                { className: "dw-row", key: "p" + rowKey },
                React.createElement("span", { className: "dw-t" }, fmtTime(p.at)),
                React.createElement("span", { className: "dw-main" }, p.program + " — " + (p.title || p.kind || ""), React.createElement("span", { className: "dw-sub" }, " · " + p.why)),
                React.createElement("input", {
                  style: { width: "150px", fontSize: "11px" },
                  placeholder: "会话 id",
                  value: draft[rowKey] || "",
                  onChange: function (e) {
                    var next = {};
                    for (var kk in draft) next[kk] = draft[kk];
                    next[rowKey] = e.target.value;
                    setDraft(next);
                  },
                }),
                React.createElement(
                  "span",
                  {
                    className: "dw-bind",
                    title: "绑定后该程序的后续弹窗按强证据注入",
                    onClick: function (e) {
                      var pid = p.program;
                      var sid = String(draft[rowKey] || "").trim();
                      if (pid && sid) bind(pid, sid);
                    },
                  },
                  "指认"
                )
              )
            );
          })(pool[j]);
        }
        var bindRows = [];
        var bindings = (state && state.bindings) || {};
        var bkeys = Object.keys(bindings);
        for (var k = 0; k < bkeys.length; k++) {
          (function (key) {
            var b = bindings[key];
            bindRows.push(
              React.createElement(
                "div",
                { className: "dw-row", key: "b" + key },
                React.createElement("span", { className: "dw-main" }, key),
                React.createElement("span", { className: "dw-sub" }, "→ " + String(b.sessionId || "").slice(0, 18)),
                React.createElement(
                  "span",
                  {
                    className: "dw-bind",
                    title: "解除绑定",
                    onClick: function () {
                      unbind(key);
                    },
                  },
                  "解除"
                )
              )
            );
          })(bkeys[k]);
        }
        var statusLine = React.createElement(
          "div",
          { className: "dw-row" },
          React.createElement(
            "span",
            { className: "dw-main" },
            "探测 " + (probeOn ? "运行中" + (state.probeAlive ? "" : "（进程未就绪）") : "已关闭") +
              " · 代点 " + (clickOn ? "开" : "关") +
              " · 会话" + (state.busy ? "运行中（1.5s/轮）" : "空闲（5s/轮）")
          )
        );
        recordPanel = React.createElement(
          "div",
          { className: "dw-panel" },
          React.createElement(
            "div",
            { className: "dw-panel-head" },
            React.createElement("span", null, "弹窗记录"),
            React.createElement(
              "span",
              {
                className: "dw-close",
                title: "收起记录面板",
                onClick: function () {
                  setOpen(false);
                },
              },
              "收起 ×"
            )
          ),
          !state
            ? [
                React.createElement("div", { className: "dw-empty", key: "e1" }, "未连接宿主 API：拿不到插件状态。"),
                React.createElement("div", { className: "dw-empty", key: "e2" }, "可能原因：插件 API 路由未注册（webServer 未就绪）。"),
                React.createElement("div", { className: "dw-empty", key: "e3" }, "请在 DSH 日志或事件日志中查「api-registered」。"),
              ]
            : [
                statusLine,
                React.createElement("div", { className: "dw-sec", key: "s1" }, "最近事件"),
                rows.length === 0 ? React.createElement("div", { className: "dw-empty", key: "r0" }, "暂无事件") : rows,
                React.createElement("div", { className: "dw-sec", key: "s2" }, "未归属池（默认不打扰；可指认给某会话建立绑定）"),
                poolRows.length === 0 ? React.createElement("div", { className: "dw-empty", key: "p0" }, "空") : poolRows,
                React.createElement("div", { className: "dw-sec", key: "s3" }, "程序 → 会话 绑定"),
                bindRows.length === 0 ? React.createElement("div", { className: "dw-empty", key: "b0" }, "暂无绑定") : bindRows,
              ]
        );
      }

      var style = { left: (pos ? pos.x : 20) + "px", top: (pos ? pos.y : 40) + "px" };
      // The .dw-float CSS starts hidden (anti-flash); reveal ONLY once the
      // position is resolved. pos===null -> keep hidden (measurable placeholder).
      style.visibility = pos ? "visible" : "hidden";

      return React.createElement(
        "div",
        { ref: rootRef, className: "dw-float", style: style, "data-dw-float": "1" },
        snap === "off"
          ? React.createElement(
              "div",
              { className: "dw-grip", ref: gripRef, title: "按住拖动，移动面板位置" },
              React.createElement(
            "div",
            { className: "dw-grip-plate" },
            React.createElement("span", { className: "dw-grip-lines" })
          )
            )
          : null,
        grid,
        recordPanel
      );
    }
    //#endregion

    //#region mount: straight into the document body (global, no slot)
    // The shell.overlay slot was tried in the first floating build, but the
    // host's consumption of it could not be confirmed (the pet's own visible
    // UI comes from body-attached DOM), and a silent slot failure meant NO
    // panel at all. body.appendChild is what dsh-pet's own bubbles use: it is
    // fixed-position, global, survives session switches, and fully under our
    // control — so it is now the primary (and only) mount path.
    exports.apply = function (ctx) {
      console.info("[dsh-dialog-watcher] apply called");
      try {
        if (!document.body) {
          console.warn("[dsh-dialog-watcher] document.body unavailable at apply time — deferring to DOMContentLoaded");
          var onReady = function () {
            document.removeEventListener("DOMContentLoaded", onReady);
            exports.apply(null);
          };
          document.addEventListener("DOMContentLoaded", onReady);
          return;
        }
        if (document.querySelector("[data-dw-float]")) {
          console.info("[dsh-dialog-watcher] panel already mounted, skipping");
          return;
        }
        if (!React) {
          console.warn("[dsh-dialog-watcher] react unavailable — panel cannot mount");
          return;
        }
        var root = document.createElement("div");
        root.setAttribute("data-dw-float-root", "1");
        document.body.appendChild(root);
        var el = React.createElement(ShellApp, null);
        if (ReactDOM && typeof ReactDOM.createRoot === "function") {
          ReactDOM.createRoot(root).render(el);
          console.info("[dsh-dialog-watcher] panel mounted via createRoot");
        } else if (ReactDOM && typeof ReactDOM.render === "function") {
          ReactDOM.render(el, root);
          console.info("[dsh-dialog-watcher] panel mounted via render");
        } else {
          console.warn(
            "[dsh-dialog-watcher] react-dom exposes no render API; keys:",
            ReactDOM ? Object.keys(ReactDOM).slice(0, 20).join(",") : "null"
          );
        }
      } catch (error) {
        console.warn("[dsh-dialog-watcher] apply failed:", (error && error.stack) || error);
      }
    };
    //#endregion

    // One-time stylesheet (kept after apply definition for clarity).
    try {
      if (typeof document !== "undefined" && !document.getElementById("dw-style")) {
        var style = document.createElement("style");
        style.id = "dw-style";
        style.textContent = CSS;
        document.head.appendChild(style);
        console.info("[dsh-dialog-watcher] stylesheet injected");
      }
    } catch (e) {
      console.warn("[dsh-dialog-watcher] style injection failed:", e);
    }

    return exports;
  },
});
