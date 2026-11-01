/**
 * dsh-dialog-watcher — injection copy (FR3.2/3.3, 需求定义.md §9).
 *
 * Every template renders a self-contained event notice: what happened, the
 * dialog evidence, the attribution basis, and an explicit "you must react"
 * ending. Word tone is graded (FR3.3):
 *   strong  -> may state "this dialog was triggered by your work"
 *   medium  -> MUST stay tentative ("may or may not be yours, you judge")
 *   install -> MUST embed the mandatory install-conduct rules verbatim
 */

/** FR3.4 mandatory install-conduct rules, verbatim. */
export const INSTALL_RULES = [
  "【安装行为处置规则】",
  "1. 用户没有明确许可本次安装时：不要继续、不要绕过。",
  "2. 关闭该安装窗口（点「取消」/「不运行」/「关闭」）。",
  "3. 继续执行与安装无关的既有工作。",
  "4. 如果没有其他可做的工作：向用户说明情况，结束本回合，等待用户指令。",
].join("\n");

const INSTALL_KINDS = new Set(["smartscreen", "installer-wizard"]);

/**
 * Per-button safety advice. The model is always told the grade; the grade
 * only changes the recommended wording for that button.
 */
function buttonLevel(text) {
  const raw = String(text || "");
  // Shell consent card buttons carry no readable label (XAML surface, no UIA,
  // no Win32 child), so they are named by position. Left-most is the
  // affirmative action - on a firewall ask that permanently allows inbound -
  // and right-most is the dismissive one that permanently blocks it.
  if (/按钮#\d+\(右\)/.test(raw)) return "L1";
  if (/按钮#\d+\(左\)/.test(raw)) return "L3";
  const t = raw.toLowerCase();
  if (/(仍要运行|run anyway|允许|allow|trust|信任)/.test(t)) return "L3";
  if (/(安装|install|下一步|next|elevat)/.test(t)) return "L3";
  if (/(取消|cancel|不运行|don'?t run|否|no|关闭|close|忽略|ignore)/.test(t)) return "L1";
  return "L2";
}

function levelAdvice(level) {
  if (level === "L1") return "L1 安全 —— 可以自行点击，无需顾虑";
  if (level === "L3") {
    return "L3 高风险 —— 等于授权启动或提权。仅在用户目标明确要求且理由充分时点，并在回复里说明你点了什么";
  }
  return "L2 中等 —— 判断是否推进任务所必需；不必要时优先取消";
}

/** One line for the notice form summary column. */
export function summaryOf(ev) {
  const app = ev.smartScreenApp || baseName(ev.exe) || ev.proc || "未知程序";
  const title = ev.title ? `「${ev.title}」` : "";
  return `弹窗：${title || kindLabel(ev)}（${app}）`.slice(0, 120);
}

export function kindLabel(ev) {
  switch (ev.kind) {
    case "smartscreen": return "SmartScreen 拦截";
    case "installer-wizard": return "安装向导";
    case "credential": return "凭据请求";
    case "system-consent": return "系统安全询问";
    case "system-modal": return "系统对话框";
    default: return "程序错误框";
  }
}

function baseName(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ms);
  }
}

/** Button list with per-button safety grade, from probe Win32 + UIA reports. */
export function buttonLines(ev) {
  const out = [];
  for (const b of ev.buttons || []) {
    if (!b || !b.text) continue;
    const where = b.cls === "PixelButton" ? `像素坐标 ${b.pixel}` : `Win32 hwnd ${b.hwnd}`;
    out.push(`- ${b.text}（${where}, ${levelAdvice(buttonLevel(b.text))}）`);
  }
  for (const b of ev.uiaButtons || []) {
    if (!b || !b.name) continue;
    if (out.some((l) => l.includes(b.name))) continue;
    out.push(`- ${b.name}（AutomationId: ${b.automationId || "n/a"}, ${levelAdvice(buttonLevel(b.name))}）`);
  }
  return out;
}

function commonFields(ev) {
  const body = (ev.body || []).filter(Boolean);
  const lines = [];
  lines.push(`- 分类：${kindLabel(ev)}（窗口类 ${ev.cls || "unknown"}）`);
  lines.push(`- 程序：${baseName(ev.exe) || ev.proc || "unknown"}（PID ${ev.pid ?? "unknown"}）`);
  if (ev.exe) lines.push(`- 路径：${ev.exe}`);
  if (ev.title) lines.push(`- 标题：${ev.title}`);
  if (body.length) lines.push(`- 正文：${body.join(" / ")}`);
  const btns = buttonLines(ev);
  if (btns.length) lines.push(`- 可点按钮：\n${btns.join("\n")}`);
  if (ev.smartScreenApp) lines.push(`- SmartScreen「应用」字段：${ev.smartScreenApp}`);
  lines.push(`- 时间：${fmtTime(ev.firstSeenMs || Date.now())} 出现，${ev.still === false ? "已消失" : "仍在显示"}`);
  return lines;
}

/**
 * Strong evidence: attribution may be stated directly.
 * evidence: string explaining which criterion hit (FR2.4).
 */
export function strongNotice(ev, evidence) {
  const lines = [`[事件提醒] 你启动的程序弹出了一个等待用户操作的窗口。`];
  lines.push(...commonFields(ev));
  lines.push(`- 归属依据：强 —— ${evidence}`);
  if (INSTALL_KINDS.has(ev.kind)) lines.push(INSTALL_RULES);
  lines.push("");
  lines.push("这是你任务过程中的一个事件。请判断如何处置：");
  lines.push("如果你有可用的窗口操作能力（本插件注册的 dialog_action 即为此用），可以点击对应按钮；也可以在回复里向用户说明，由用户处理。");
  return lines.join("\n");
}

/**
 * Medium evidence after a successful two-command/two-dialog confirmation:
 * the tone MUST stay tentative (FR3.3) — never assert causality.
 * pair: { commandA, commandB, firstSeenMs }
 */
export function mediumNotice(ev, evidence, pair) {
  const lines = [`[事件提醒] 检测到一个等待操作的窗口，它**可能**与你刚才的操作有关，也可能无关。`];
  lines.push(...commonFields(ev));
  lines.push(`- 归属线索：${evidence}`);
  if (pair) {
    lines.push(
      `- 配对依据：同一程序在两条不同命令执行期间各弹出一次（C1「${truncate(pair.commandA, 60)}」→ C2「${truncate(pair.commandB, 60)}」），但这只是一条行为线索，**不能证明是你的行为导致的**`
    );
  }
  lines.push("");
  lines.push("请你自己判断：");
  lines.push("- 如果你认为它与你的操作有关 → 说明原因，并调整后续做法；");
  lines.push("- 如果你认为与你无关 → 忽略它，**不要因此改变原计划**。");
  return lines.join("\n");
}

/** SmartScreen strong hit (H3): app field matched a command's exe hint. */
export function smartScreenNotice(ev, evidence) {
  const lines = [`[事件提醒] 有程序被 Windows SmartScreen 拦截，窗口正在等待用户选择。`];
  lines.push(...commonFields(ev));
  lines.push(`- 归属依据：强 —— ${evidence}`);
  lines.push(INSTALL_RULES);
  lines.push("");
  lines.push(
    "如果用户此前确实明确要求安装/运行本程序：这是任务的一部分，可以用可用的窗口操作能力点「仍要运行」（L3，须在回复里说明）；否则按上面规则关闭窗口。"
  );
  return lines.join("\n");
}

/**
 * Windows Security Center consent card (firewall ask, ...). Unlike every other
 * kind, the choice made here is PERMANENT and the system asks only once per
 * program path - so the notice states the consequences before advising
 * anything, and never presents "allow" as the easy default.
 * tentative=true renders the medium-evidence wording (FR3.3: must not assert
 * causality).
 */
export function systemConsentNotice(ev, evidence, tentative) {
  const lines = [
    tentative
      ? "[事件提醒] 系统弹出了一个安全询问窗口（Windows 安全中心），它**可能**与你刚才的操作有关，也可能无关。"
      : "[事件提醒] 系统弹出了一个安全询问窗口（Windows 安全中心），正在等待用户选择。",
  ];
  lines.push(...commonFields(ev));
  lines.push(tentative ? `- 归属线索：${evidence}` : `- 归属依据：强 —— ${evidence}`);
  lines.push("");
  lines.push("【这类窗口的特殊后果 · 与普通报错框不同】");
  lines.push("- 选择「允许」→ 为该程序写入**永久放行**规则，外部主机可以连入该程序监听的端口；");
  lines.push("- 选择「取消」→ 为该程序写入**永久阻止**规则；");
  lines.push("- 同一个程序路径**只会询问一次**，选完不再弹；之后想改只能由用户到防火墙设置里手动调整。");
  lines.push("- 按钮文字拿不到（界面由 XAML 绘制，不暴露给 Win32/UIA），按钮只能按位置认：**最左=允许，最右=取消**。");
  lines.push("");
  lines.push("处置建议：");
  lines.push("- 若这次监听端口是你任务的正常需要、且用户已认可 → 可点最左按钮（L3 高风险，须在回复里说明你点了什么）；");
  lines.push("- 其余情况一律点最右按钮（取消）—— 它只是不允许外部连入，不影响本机向外访问；");
  lines.push("- 拿不准就向用户说明并等待指令，**不要擅自放行**。");
  return lines.join("\n");
}

/** FR3.6: lightweight unblock notice after an injected dialog goes away. */
export function goneNotice(ev) {
  const app = ev.smartScreenApp || baseName(ev.exe) || "先前报告的程序";
  return `[事件提醒] 此前提醒的弹窗（${app}${ev.title ? `「${ev.title}」` : ""}）已被处理，窗口已消失，相关阻塞已解除。无需进一步操作。`;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
