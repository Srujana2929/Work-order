// AI assistant: floating button + chat panel for Admins and Supervisors.
// The server answers from a live database snapshot via Gemini (with retries
// and a fallback model - see backend/gemini_retry.py). History lives in
// memory for this session only - it's cleared on sign-out or reload and never
// stored on the server; so is the thumbs up/down feedback.
import { api } from "./api.js";
import { motionOK } from "./motion.js";
import { can, session } from "./session.js";
import { esc, fmt, icons, priorityMeter, statusBadge, toast } from "./ui.js";

/** The assistant's name, used everywhere it appears in the UI. */
export const ASSISTANT_NAME = "Torque";

const MAX_CHARS = 2000;
const STATUSES = ["Pending", "Assigned", "In Progress", "On Hold", "Completed", "Verified", "Closed"];
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const STARTERS = [
  "What's overdue right now?",
  "Who has the most open work orders?",
  "How many technicians should I assign next week?",
  "Which machine has needed the most work?",
];
// Follow-up chips after an answer, picked by what the question/answer was about.
const FOLLOW_UPS = [
  [/staff|headcount|hire|technicians should|supervisors do|assign next week/, ["Show overdue jobs", "Who is overloaded?", "What's the backlog trend?"]],
  [/overdue|late|past due/, ["Who is assigned to the overdue jobs?", "What's due in the next 7 days?", "Who is overloaded?"]],
  [/overload|most open|workload|capacity|busiest|per technician|open work orders/, ["Show overdue jobs", "Who has capacity this week?", "Compare technician ratings"]],
  [/rating|stars|rated/, ["Who is overloaded?", "Show recently closed work orders"]],
  [/cost|spend|spent|budget|material/, ["Which machine costs the most?", "How does this month compare to last month?"]],
  [/machine|breakdown|downtime/, ["Show open breakdowns", "Which machine costs the most?"]],
];
const PREF_KEY = "torque-prefs";

const ICON = {
  gauge: `<svg class="tq-gauge" viewBox="0 0 32 32" aria-hidden="true"><circle class="tq-gauge__rim" cx="16" cy="16" r="13"/>
    <path class="tq-gauge__ticks" d="M7.5 21.5l1.6-.9M5.6 14.4l1.8.3M9.4 8.6l1.2 1.4M16 6v1.8M22.6 8.6l-1.2 1.4M26.4 14.4l-1.8.3M24.5 21.5l-1.6-.9"/>
    <path class="tq-gauge__arc" d="M21.7 9.6a9 9 0 0 1 3 7.4"/>
    <g class="tq-gauge__needle"><path d="M16 17.5V9"/></g><circle class="tq-gauge__hub" cx="16" cy="16.5" r="2"/></svg>`,
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7 13V4H4v9zM7 13l4 7c1.5 0 2.5-1 2.2-2.6L12.6 14H19a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.8 4H7"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/></svg>',
};

let history = [];          // { id, role: "user" | "model", text, asOf?, vote? } - successful turns only
let els = null;            // { fab, panel, log, form, input, send, avatar }
let busy = false;
let lastFailed = null;     // question to retry after an error
let nextId = 1;
let revealId = null;       // model message to reveal with the typewriter on its first render
let stopReveal = null;

const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

/** Show the assistant if the signed-in user may use it (call after sign-in). */
export function mountAssistant() {
  if (!can("assistant:use")) { unmountAssistant(); return; }
  if (els) return;
  const fab = document.createElement("button");
  fab.className = "ai-fab" + (prefs.opened ? "" : " ai-fab--pulse");
  fab.type = "button";
  fab.setAttribute("aria-label", `Ask ${ASSISTANT_NAME}`);
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "ai-panel");
  fab.innerHTML = `${ICON.gauge}<span class="ai-fab__label">Ask ${esc(ASSISTANT_NAME)}</span>`;

  const panel = document.createElement("section");
  panel.className = "ai-panel" + (prefs.wide ? " ai-panel--wide" : "");
  panel.id = "ai-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", ASSISTANT_NAME);
  panel.innerHTML = `
    <header class="ai-panel__head">
      <span class="tq-avatar" aria-hidden="true">${ICON.gauge}</span>
      <div class="ai-panel__heading"><div class="ai-panel__title">${esc(ASSISTANT_NAME)}</div>
        <div class="ai-panel__state" aria-live="polite"></div></div>
      <button class="icon-btn icon-btn--sm ai-expand" type="button" data-ai="expand"></button>
      <button class="icon-btn icon-btn--sm" type="button" data-ai="clear" title="Clear chat" aria-label="Clear chat">${icons.trash}</button>
      <button class="icon-btn icon-btn--sm" type="button" data-ai="close" title="Close (Esc)" aria-label="Close ${esc(ASSISTANT_NAME)}">${icons.close}</button>
    </header>
    <div class="ai-panel__log" aria-live="polite"></div>
    <form class="ai-panel__form" novalidate>
      <div class="ai-panel__input">
        <textarea rows="1" maxlength="${MAX_CHARS}" placeholder="Ask ${esc(ASSISTANT_NAME)} about your work orders…" aria-label="Your question"></textarea>
        <button class="ai-send" type="submit" aria-label="Send">${icons.send}</button>
      </div>
      <p class="ai-panel__fine">AI can make mistakes. Check important details.</p>
    </form>`;

  document.body.append(fab, panel);
  document.body.classList.add("has-ai");
  els = { fab, panel, log: panel.querySelector(".ai-panel__log"), form: panel.querySelector("form"),
          input: panel.querySelector("textarea"), send: panel.querySelector(".ai-send"),
          avatar: panel.querySelector(".tq-avatar"), state: panel.querySelector(".ai-panel__state") };
  syncExpandButton();

  fab.addEventListener("click", () => setOpen(panel.hidden));
  panel.addEventListener("click", onPanelClick);
  document.addEventListener("keydown", onKeydown);
  els.form.addEventListener("submit", (e) => { e.preventDefault(); ask(els.input.value); });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(els.input.value); }
  });
  els.input.addEventListener("input", autoGrow);
  render();
}

/** Remove the assistant and forget the conversation (on sign-out). */
export function unmountAssistant() {
  history = [];
  lastFailed = null;
  busy = false;
  revealId = null;
  if (stopReveal) stopReveal();
  if (!els) return;
  document.removeEventListener("keydown", onKeydown);
  els.fab.remove();
  els.panel.remove();
  document.body.classList.remove("has-ai", "ai-open");
  els = null;
}

function setOpen(open) {
  const { panel, fab } = els;
  fab.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("ai-open", open);
  if (open) {
    if (!prefs.opened) { prefs.opened = true; savePrefs(); fab.classList.remove("ai-fab--pulse"); }
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("is-open"));
    setTimeout(() => els && els.input.focus({ preventScroll: true }), motionOK() ? 120 : 0);
    scrollToEnd();
  } else {
    panel.classList.remove("is-open");
    const hide = () => { if (els && !panel.classList.contains("is-open")) panel.hidden = true; };
    if (motionOK()) setTimeout(hide, 220); else hide();
    fab.focus({ preventScroll: true });
  }
}

function syncExpandButton() {
  const b = els.panel.querySelector(".ai-expand");
  const wide = els.panel.classList.contains("ai-panel--wide");
  b.innerHTML = wide ? ICON.shrink : ICON.expand;
  b.title = wide ? "Smaller panel" : "Larger panel";
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-pressed", String(wide));
}

// Escape closes the open panel from anywhere - unless a modal is on top
// (e.g. a work order opened from an answer): then the modal closes first.
function onKeydown(e) {
  if (e.key !== "Escape" || !els || els.panel.hidden || !els.panel.classList.contains("is-open")) return;
  if (document.body.classList.contains("modal-open")) return;
  setOpen(false);
}

function onPanelClick(e) {
  const act = e.target.closest("[data-ai]");
  if (act) {
    const a = act.dataset.ai;
    const msg = history.find((m) => String(m.id) === act.closest("[data-msg]")?.dataset.msg);
    if (a === "close") setOpen(false);
    else if (a === "clear") { if (busy) return; history = []; lastFailed = null; render(); els.input.focus(); }
    else if (a === "expand") {
      els.panel.classList.toggle("ai-panel--wide");
      prefs.wide = els.panel.classList.contains("ai-panel--wide"); savePrefs();
      syncExpandButton(); scrollToEnd();
    }
    else if (a === "suggest") ask(act.dataset.q || act.textContent);
    else if (a === "retry" && lastFailed) ask(lastFailed, { retry: true });
    else if (a === "copy" && msg) copyText(msg.text, act);
    else if ((a === "up" || a === "down") && msg) {
      msg.vote = msg.vote === a ? null : a;          // in memory only, never sent anywhere
      act.parentElement.querySelectorAll("[data-ai=up],[data-ai=down]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.ai === msg.vote)));
    }
    return;
  }
  // Following a link (e.g. a WO number) on a phone: get the panel out of the way.
  if (e.target.closest("a[href^='#/']") && window.matchMedia("(max-width: 600px)").matches) setOpen(false);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
  button.classList.add("is-done");
  setTimeout(() => button.classList.remove("is-done"), 1200);
  toast("Answer copied");
}

async function ask(raw, { retry = false } = {}) {
  const text = (raw || "").trim();
  if (!text || busy) return;
  busy = true;
  lastFailed = null;
  if (!retry) {
    // A new question after a failed one replaces it (turns must alternate user/model).
    if (history.length && history[history.length - 1].role === "user") history.pop();
    history.push({ id: nextId++, role: "user", text });
  }
  els.input.value = "";
  autoGrow();
  setThinking(true);
  render({ typing: true });
  try {
    const res = await api("/assistant/chat", {
      method: "POST",
      body: { messages: history.slice(-20).map(({ role, text: t }) => ({ role, text: t })) },
    });
    const id = nextId++;
    history.push({ id, role: "model", text: res.reply, asOf: res.data_as_of });
    revealId = id;
    render();
  } catch (err) {
    lastFailed = text;
    render({ error: err });
  } finally {
    busy = false;
    setThinking(false);
    if (els) { els.send.disabled = false; els.input.focus({ preventScroll: true }); }
  }
}

// The header only says "Thinking…" (static); the one animated indicator is
// the gauge in the message list.
function setThinking(on) {
  if (!els) return;
  els.state.textContent = on ? "Thinking…" : "";
}

// ---------------------------------------------------------------- rendering

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const first = ((session.user && session.user.full_name) || "").replace(/\(.*?\)/g, "").trim().split(/\s+/)[0];
  return `${part}${first ? `, ${first}` : ""}. What are we looking at?`;
}

function chips(list, disabled) {
  return `<div class="ai-suggest">${list.map((q) =>
    `<button type="button" class="ai-chip" data-ai="suggest"${disabled ? " disabled" : ""}>${esc(q)}</button>`).join("")}</div>`;
}

function followUps(question, answer) {
  const hay = `${question} ${answer}`.toLowerCase();
  const asked = question.trim().toLowerCase();
  const out = [];
  const wo = /\bWO-\d{1,7}\b/.exec(answer);
  for (const [re, list] of FOLLOW_UPS) if (re.test(hay)) out.push(...list);
  if (!out.length) out.push(...STARTERS);
  if (wo) out.unshift(`Tell me more about ${wo[0]}`);
  return [...new Set(out)].filter((q) => q.toLowerCase() !== asked).slice(0, 3);
}

function render({ typing = false, error = null } = {}) {
  if (!els) return;
  if (stopReveal) stopReveal();
  const last = history[history.length - 1];
  const intro = `<div class="ai-msg ai-msg--model ai-msg--intro">
      <p class="ai-hello">${esc(greeting())}</p>
      <p>I read your live work orders, workload and machines. Try one of these:</p>
      ${chips(STARTERS, typing)}
    </div>`;
  const turns = history.map((m, i) => {
    const isLast = i === history.length - 1;
    const anim = isLast ? " ai-in" : "";
    if (m.role === "user") return `<div class="ai-msg ai-msg--user${anim}">${esc(m.text).replace(/\n/g, "<br>")}</div>`;
    const question = history[i - 1] ? history[i - 1].text : "";
    return `<div class="ai-msg ai-msg--model${anim}" data-msg="${m.id}">
        <div class="ai-answer">${formatAnswer(m.text)}</div>
        <div class="ai-msg__foot">
          <span class="ai-msg__meta">${m.asOf ? `Live data · ${esc(fmt.time(m.asOf))}` : ""}</span>
          <span class="ai-actions">
            <button type="button" class="ai-act" data-ai="copy" title="Copy answer" aria-label="Copy answer">${ICON.copy}</button>
            <button type="button" class="ai-act" data-ai="up" title="Helpful" aria-label="Helpful" aria-pressed="${m.vote === "up"}">${ICON.up}</button>
            <button type="button" class="ai-act" data-ai="down" title="Not helpful" aria-label="Not helpful" aria-pressed="${m.vote === "down"}">${ICON.down}</button>
          </span>
        </div>
      </div>${isLast && !typing && !error ? `<div class="ai-follow${anim}" data-follow>${chips(followUps(question, m.text), false)}</div>` : ""}`;
  }).join("");
  const tail = typing
    ? `<div class="ai-msg ai-msg--model ai-typing ai-in" role="status" aria-label="${esc(ASSISTANT_NAME)} is thinking">
         <svg class="ai-sweep" viewBox="0 0 40 22" aria-hidden="true"><path d="M4 20a16 16 0 0 1 32 0"/><path class="ai-sweep__needle" d="M20 20 20 7"/></svg></div>`
    : error
      ? `<div class="ai-msg ai-msg--error ai-in" role="alert">${icons.alert}<div><p>${esc(friendly(error))}</p>
           <button class="btn btn--sm" type="button" data-ai="retry">Try again</button></div></div>`
      : "";
  els.log.innerHTML = intro + turns + tail;
  els.send.disabled = typing;
  if (last && last.role === "model" && last.id === revealId) {
    revealId = null;
    const msg = els.log.querySelector(`[data-msg="${last.id}"]`);
    typewrite(msg.querySelector(".ai-answer"), [msg.querySelector(".ai-msg__foot"), els.log.querySelector("[data-follow]")]);
  }
  scrollToEnd();
}

function friendly(err) {
  if (err.status === 0) return "Couldn't reach the server. Check your connection and try again.";
  if (err.status === 403) return `${ASSISTANT_NAME} is only available to supervisors and admins.`;
  return err.message || "Something went wrong. Please try again.";
}

function nearBottom() {
  const l = els.log;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}

function scrollToEnd() {
  if (!els) return;
  requestAnimationFrame(() => { if (els) els.log.scrollTop = els.log.scrollHeight; });
}

function autoGrow() {
  const t = els.input;
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}

/** Typewriter reveal of an answer that has already arrived in full. Text
 *  appears character by character; badges, WO chips and charts appear whole
 *  when the cursor reaches them. `after` elements fade in once it's done. */
function typewrite(root, after = []) {
  const extras = after.filter(Boolean);
  if (!motionOK()) return;
  const ATOMIC = ".status, .prio, .ai-wo, .ai-bars, code";
  const units = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) { if (child.nodeValue) units.push({ text: child, full: child.nodeValue }); }
      else if (child.nodeType === Node.ELEMENT_NODE) {
        child.classList.add("tw-off");
        if (child.matches(ATOMIC)) units.push({ el: child }); else walk(child);
      }
    }
  };
  walk(root);
  const total = units.reduce((n, u) => n + (u.text ? u.full.length : 8), 0);
  if (!total) return;
  units.forEach((u) => { if (u.text) u.text.nodeValue = ""; });
  extras.forEach((el) => el.classList.add("tw-wait"));
  const show = (node) => { for (let n = node; n && n !== root; n = n.parentElement) n.classList && n.classList.remove("tw-off"); };
  const duration = Math.min(1600, Math.max(350, total * 9));
  const start = performance.now();
  let index = 0, done = 0, frame = 0;
  const finish = () => {
    cancelAnimationFrame(frame);
    units.forEach((u) => { if (u.text) u.text.nodeValue = u.full; });
    root.querySelectorAll(".tw-off").forEach((el) => el.classList.remove("tw-off"));
    extras.forEach((el) => el.classList.remove("tw-wait"));
    stopReveal = null;
  };
  stopReveal = finish;
  const tick = (now) => {
    const target = Math.min(total, Math.ceil(((now - start) / duration) * total));
    const stick = nearBottom();
    while (index < units.length && done < target) {
      const u = units[index];
      if (u.el) { show(u.el); done += 8; index++; continue; }
      show(u.text.parentElement);
      const take = Math.min(u.full.length - u.text.nodeValue.length, target - done);
      u.text.nodeValue = u.full.slice(0, u.text.nodeValue.length + take);
      done += take;
      if (u.text.nodeValue.length === u.full.length) index++;
    }
    if (stick) els.log.scrollTop = els.log.scrollHeight;
    if (index >= units.length) { finish(); if (stick) scrollToEnd(); return; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- answer formatting

/** Safe formatter for the model's answers: everything is escaped first. Handles
 *  paragraphs, "- " / "1. " lists, small | tables |, **bold**, `code`, ```bars
 *  blocks (drawn as SVG bars), WO-numbers (chips that open the work order) and
 *  statuses/priorities (the app's own badges). */
function formatAnswer(text) {
  const badge = (word) => STATUSES.includes(word) ? statusBadge(word) : PRIORITIES.includes(word) ? priorityMeter(word) : null;
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, (m, c) => {
      const raw = c.replace(/&amp;/g, "&");
      return badge(raw.trim()) || `<code>${c}</code>`;
    })
    .replace(/\bWO-(\d{1,7})\b/g, (m, n) => `<a class="ai-wo" href="#/work-orders/${Number(n)}">${m}</a>`);
  const cell = (s) => badge(s.trim().replace(/^`|`$/g, "")) || inline(s.trim());

  const lines = String(text).replace(/\r/g, "").split("\n");
  let html = "", para = [], list = null;
  const flushPara = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.type}>`; list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const fence = /^\s*```\s*(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      html += fence[1].toLowerCase() === "bars" ? (bars(body) || "") : `<pre><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      flush();
      const split = (l) => l.trim().replace(/^\||\|$/g, "").split("|");
      const head = split(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(split(lines[i]));
      i--;
      const num = (s) => /^[\s$€£]*-?[\d,.]+\s*%?h?\s*$/.test(s) ? " class=\"num\"" : "";
      html += `<div class="ai-table"><table><thead><tr>${head.map((h) => `<th>${inline(h.trim())}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td${num(c)}>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(inline((bullet || numbered)[1]));
      continue;
    }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    para.push(heading ? `<b>${inline(heading[1])}</b>` : inline(line));
  }
  flush();
  return html;
}

/** "label: number" lines -> a small horizontal bar chart (SVG, no library). */
function bars(lines) {
  const rows = lines.map((l) => /^\s*[-*]?\s*(.+?)\s*[:=]\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(l))
    .filter(Boolean).slice(0, 8)
    .map(([, label, value, unit]) => ({ label: label.replace(/\*\*/g, ""), value: Number(value.replace(",", ".")), unit: unit.trim() }));
  if (!rows.length) return "";
  const max = Math.max(...rows.map((r) => r.value), 1);
  const ROW = 24, LABEL = 124, BAR = 140, W = LABEL + BAR + 44;
  const clip = (s) => (s.length > 18 ? s.slice(0, 17) + "…" : s);
  const top = Math.max(...rows.map((r) => r.value));
  return `<figure class="ai-bars" role="img" aria-label="${esc(rows.map((r) => `${r.label}: ${r.value}`).join(", "))}">
    <svg viewBox="0 0 ${W} ${rows.length * ROW}" preserveAspectRatio="xMinYMin meet">${rows.map((r, i) => {
      const w = Math.max(2, (r.value / max) * BAR);
      const y = i * ROW;
      return `<g style="--i:${i}">
        <text class="ai-bars__label" x="${LABEL - 8}" y="${y + 16}" text-anchor="end"><title>${esc(r.label)}</title>${esc(clip(r.label))}</text>
        <rect class="ai-bars__track" x="${LABEL}" y="${y + 5}" width="${BAR}" height="13" rx="3"/>
        <rect class="ai-bars__bar${r.value === top ? " is-top" : ""}" x="${LABEL}" y="${y + 5}" width="${w.toFixed(1)}" height="13" rx="3"/>
        <text class="ai-bars__value" x="${LABEL + w + 6}" y="${y + 16}">${esc(String(r.value))}${r.unit ? ` ${esc(r.unit.slice(0, 8))}` : ""}</text></g>`;
    }).join("")}</svg></figure>`;
}
