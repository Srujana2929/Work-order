// AI assistant (EXPERIMENTAL): floating bubble + slide-in chat panel for
// Admins and Supervisors. The server answers from a live database snapshot
// via Gemini. History lives in memory for this session only - it's cleared
// on sign-out or reload and never stored on the server.
import { api } from "./api.js";
import { motionOK } from "./motion.js";
import { can } from "./session.js";
import { esc, iconBadge, icons } from "./ui.js";

const SUGGESTIONS = [
  "How many technicians should I assign next week?",
  "How many supervisors do we need?",
  "What's overdue right now?",
  "Who has the most open work orders?",
];
const MAX_CHARS = 2000;

let history = [];          // { role: "user" | "model", text, asOf? } - successful turns only
let els = null;            // { fab, panel, log, form, input, send }
let busy = false;
let lastFailed = null;     // question to retry after an error

/** Show the assistant if the signed-in user may use it (call after sign-in). */
export function mountAssistant() {
  if (!can("assistant:use")) { unmountAssistant(); return; }
  if (els) return;
  const fab = document.createElement("button");
  fab.className = "ai-fab";
  fab.type = "button";
  fab.setAttribute("aria-label", "Open AI assistant");
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "ai-panel");
  fab.innerHTML = `${icons.sparkle}<span class="ai-fab__label">Ask AI</span>`;

  const panel = document.createElement("section");
  panel.className = "ai-panel";
  panel.id = "ai-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "AI assistant");
  panel.innerHTML = `
    <header class="ai-panel__head">
      ${iconBadge("sparkle", "var(--amber)", "sm")}
      <div class="ai-panel__heading"><div class="ai-panel__title">Assistant</div>
        <div class="ai-panel__sub">Answers from your live work-order data</div></div>
      <button class="icon-btn icon-btn--sm" type="button" data-ai="new" title="New conversation" aria-label="New conversation">${icons.restore}</button>
      <button class="icon-btn icon-btn--sm" type="button" data-ai="close" title="Close" aria-label="Close assistant">${icons.close}</button>
    </header>
    <div class="ai-panel__notice">${icons.info}<span><b>Experimental</b> - AI answers can be wrong. Verify important decisions.</span></div>
    <div class="ai-panel__log" aria-live="polite"></div>
    <form class="ai-panel__form" novalidate>
      <textarea rows="1" maxlength="${MAX_CHARS}" placeholder="Ask about work orders, workload, staffing…" aria-label="Your question"></textarea>
      <button class="ai-send" type="submit" aria-label="Send">${icons.send}</button>
    </form>`;

  document.body.append(fab, panel);
  document.body.classList.add("has-ai");
  els = { fab, panel, log: panel.querySelector(".ai-panel__log"), form: panel.querySelector("form"),
          input: panel.querySelector("textarea"), send: panel.querySelector(".ai-send") };

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
    if (a === "close") setOpen(false);
    else if (a === "new") { if (busy) return; history = []; lastFailed = null; render(); els.input.focus(); }
    else if (a === "suggest") ask(act.textContent);
    else if (a === "retry" && lastFailed) ask(lastFailed, { retry: true });
    return;
  }
  // Following a link (e.g. a WO number) on a phone: get the panel out of the way.
  if (e.target.closest("a[href^='#/']") && window.matchMedia("(max-width: 600px)").matches) setOpen(false);
}

async function ask(raw, { retry = false } = {}) {
  const text = (raw || "").trim();
  if (!text || busy) return;
  busy = true;
  lastFailed = null;
  if (!retry) {
    // A new question after a failed one replaces it (turns must alternate user/model).
    if (history.length && history[history.length - 1].role === "user") history.pop();
    history.push({ role: "user", text });
  }
  els.input.value = "";
  autoGrow();
  render({ typing: true });
  try {
    const res = await api("/assistant/chat", {
      method: "POST",
      body: { messages: history.slice(-20).map(({ role, text: t }) => ({ role, text: t })) },
    });
    history.push({ role: "model", text: res.reply, asOf: res.data_as_of });
    render();
  } catch (err) {
    lastFailed = text;
    render({ error: err });
  } finally {
    busy = false;
    if (els) { els.send.disabled = false; els.input.focus({ preventScroll: true }); }
  }
}

function render({ typing = false, error = null } = {}) {
  if (!els) return;
  const intro = `<div class="ai-msg ai-msg--model ai-msg--intro">
      <p>Hi! I can answer questions about your <b>live data</b> - work orders, overdue jobs, who's carrying the most work, machines, and staffing estimates.</p>
      <div class="ai-suggest">${SUGGESTIONS.map((s) => `<button type="button" class="ai-chip" data-ai="suggest">${esc(s)}</button>`).join("")}</div>
    </div>`;
  const turns = history.map((m, i) => m.role === "user"
    ? `<div class="ai-msg ai-msg--user${i === history.length - 1 ? " fade-up" : ""}">${esc(m.text).replace(/\n/g, "<br>")}</div>`
    : `<div class="ai-msg ai-msg--model${i === history.length - 1 ? " fade-up" : ""}">${formatAnswer(m.text)}
        ${m.asOf ? `<div class="ai-msg__meta">Based on live data as of ${esc(m.asOf.replace("T", " "))}</div>` : ""}</div>`).join("");
  const tail = typing
    ? `<div class="ai-msg ai-msg--model ai-typing" aria-label="Assistant is thinking"><i></i><i></i><i></i></div>`
    : error
      ? `<div class="ai-msg ai-msg--error fade-up" role="alert">${icons.alert}<div><p>${esc(friendly(error))}</p>
           <button class="btn btn--sm" type="button" data-ai="retry">Try again</button></div></div>`
      : "";
  els.log.innerHTML = intro + turns + tail;
  els.send.disabled = typing;
  els.log.querySelectorAll("[data-ai=suggest]").forEach((b) => { b.disabled = typing; });
  scrollToEnd();
}

function friendly(err) {
  if (err.status === 0) return "Couldn't reach the server. Check your connection and try again.";
  if (err.status === 403) return "The assistant is only available to supervisors and admins.";
  return err.message || "Something went wrong. Please try again.";
}

function scrollToEnd() {
  if (!els) return;
  requestAnimationFrame(() => { els.log.scrollTop = els.log.scrollHeight; });
}

function autoGrow() {
  const t = els.input;
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}

/** Tiny, safe formatter for the model's answers: everything is escaped first,
 *  then paragraphs, "- " / "1. " lists, **bold**, `code` and WO-number links. */
function formatAnswer(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\bWO-(\d{1,7})\b/g, (m, n) => `<a href="#/work-orders/${Number(n)}">${m}</a>`);
  const blocks = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { list = { type, items: [] }; blocks.push(list); }
      list.items.push(inline((bullet || numbered)[1]));
      continue;
    }
    list = null;
    if (!line.trim()) { blocks.push(null); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push({ type: "p", html: heading ? `<b>${inline(heading[1])}</b>` : inline(line) });
  }
  let html = "", para = [];
  const flush = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  for (const b of blocks) {
    if (!b) { flush(); continue; }
    if (b.type === "p") { para.push(b.html); continue; }
    flush();
    html += `<${b.type}>${b.items.map((i) => `<li>${i}</li>`).join("")}</${b.type}>`;
  }
  flush();
  return html;
}
