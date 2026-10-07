// Shared UI helpers: escaping, formatting, badges, modals, toasts, forms.
import { motionOK, skeletonBlock } from "./motion.js";

// ------------------------------------------------------------ escaping / format

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escape any value for safe insertion into HTML. Use for ALL API data. */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const fmt = {
  woId: (id) => "WO-" + String(id).padStart(5, "0"),
  money: (n) => (n === null || n === undefined) ? "—"
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  num: (n) => (n === null || n === undefined) ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }),
  date: (iso) => iso ? iso.slice(0, 10) : "—",
  dateTime: (iso) => iso ? iso.slice(0, 16).replace("T", " ") : "—",
  daysOverdue(iso) {
    if (!iso) return 0;
    const due = new Date(iso + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((today - due) / 86400000);
  },
};

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Set the page heading and breadcrumb. crumbs: ["Label" | ["Label", "#/href"], ...] */
export const APP_TITLE = "Work Order Management System";

export function setPage(title, crumbs = []) {
  const titleEl = document.getElementById("page-title");
  if (titleEl.textContent !== title) {
    titleEl.textContent = title;
    titleEl.classList.remove("title-in"); void titleEl.offsetWidth; titleEl.classList.add("title-in");
  }
  document.getElementById("page-crumb").innerHTML = [APP_TITLE, ...crumbs]
    .map((c) => Array.isArray(c) ? (c[1] ? `<a href="${esc(c[1])}">${esc(c[0])}</a>` : esc(c[0])) : esc(c))
    .join(" / ");
  document.title = `${title} · ${APP_TITLE}`;
}

// ------------------------------------------------------------ badges

const PRIORITY_LEVEL = { Low: 1, Medium: 2, High: 3, Critical: 4 };

// The optional `key` (data-morph) lets a re-render animate from the old state to the new one.
const morphAttr = (key) => (key ? ` data-morph="${esc(key)}"` : "");

export const statusBadge = (status, key) =>
  `<span class="status" data-status="${esc(status)}"${morphAttr(key)}>${esc(status)}</span>`;

export const priorityMeter = (priority, key) =>
  `<span class="prio" data-level="${PRIORITY_LEVEL[priority] || 0}"${morphAttr(key)}>
     <span class="prio__bars"><i></i><i></i><i></i><i></i></span>${esc(priority)}</span>`;

export const progressBar = (value, key) => {
  const v = Number(value) || 0;
  return `<span class="progress"><span class="progress__track"><span class="progress__fill intro" style="width:${v}%"${morphAttr(key)}></span></span><span class="progress__val">${v}%</span></span>`;
};

export const icons = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  orders: '<svg viewBox="0 0 24 24"><path d="M9 4h6v3H9z"/><path d="M7 5H5v16h14V5h-2"/><path d="M8 12h8M8 16h5"/></svg>',
  machine: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.5 3.6 5.2"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3.5 17.2a1.8 1.8 0 0 0 2.6 2.6l5.8-5.8a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.3-.6-.6-2.3z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.7L16.5 9.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  coins: '<svg viewBox="0 0 24 24"><ellipse cx="9" cy="7" rx="6" ry="2.5"/><path d="M3 7v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7"/><path d="M9 13.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4c0-1.4-2.7-2.5-6-2.5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  building: '<svg viewBox="0 0 24 24"><path d="M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/></svg>',
  activity: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 3.5 3.5L15 14l5 4.5"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3.5 13.8 9l5.7 1.9-5.7 1.9L12 18.5l-1.8-5.7L4.5 11 10.2 9z"/><path d="M19 3v3M17.5 4.5h3"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3.5 12.5V4h8.5l8.5 8.5-8 8z"/><circle cx="8" cy="8.5" r="1.4"/></svg>',
  team: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="3"/><path d="M6.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="5" cy="10" r="2.2"/><path d="M1.8 17.5c.4-2 1.6-3.2 3.2-3.5"/><circle cx="19" cy="10" r="2.2"/><path d="M22.2 17.5c-.4-2-1.6-3.2-3.2-3.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
};

/** Coloured circular icon badge. tone: any CSS colour (usually a var()). */
export const iconBadge = (icon, tone, size = "") =>
  `<span class="icon-badge${size ? ` icon-badge--${size}` : ""}" style="--tone:${tone}">${icons[icon] || icon}</span>`;

/** Read-only star rating (0-5, fractions shown as partial fill). */
export function stars(value, { size = "" } = {}) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  const row = icons.star.repeat(5);
  return `<span class="stars${size ? ` stars--${size}` : ""}" role="img" aria-label="${v.toFixed(1)} out of 5 stars" style="--fill:${(v / 5) * 100}%">
    <span class="stars__base" aria-hidden="true">${row}</span><span class="stars__fill" aria-hidden="true">${row}</span></span>`;
}

/** Compact average-rating badge from a {average, count} summary (null -> ""). */
export function ratingSummary(r, { empty = "No ratings yet" } = {}) {
  if (!r) return "";
  if (!r.count) return `<span class="rating rating--none">${esc(empty)}</span>`;
  return `<span class="rating" title="${r.average.toFixed(2)} average from ${r.count} rating${r.count === 1 ? "" : "s"}">
    ${stars(r.average, { size: "sm" })}<b>${r.average.toFixed(1)}</b><span class="muted">(${r.count})</span></span>`;
}

/** Interactive 1-5 star input (radio group named `name`). */
export function starPicker(name, value = 0) {
  const id = `sp-${Math.random().toString(36).slice(2, 7)}`;
  const words = ["", "Poor", "Below expectations", "Good", "Very good", "Excellent"];
  return `<div class="star-field"><div class="star-picker" role="radiogroup" aria-label="Rating">
    ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="${id}-${n}" name="${name}" value="${n}"${n === Number(value) ? " checked" : ""}>
      <label for="${id}-${n}" title="${n} star${n === 1 ? "" : "s"} - ${words[n]}">${icons.star}<span class="sr-only">${n} star${n === 1 ? "" : "s"}</span></label>`).join("")}
    </div><span class="star-picker__word" aria-live="polite"></span></div>`;
}

/** Wire a starPicker inside `root`: shows the word for the chosen value; the
 *  chosen star can be clicked again to clear it. */
export function wireStarPicker(root) {
  const picker = root.querySelector(".star-picker");
  if (!picker) return;
  const words = ["", "Poor", "Below expectations", "Good", "Very good", "Excellent"];
  const word = picker.parentElement.querySelector(".star-picker__word");
  const sync = () => {
    const c = picker.querySelector("input:checked");
    word.textContent = c ? words[Number(c.value)] : "Not rated";
  };
  picker.addEventListener("click", (e) => {
    const label = e.target.closest("label");
    if (!label) return;
    const input = picker.querySelector(`#${CSS.escape(label.htmlFor)}`);
    if (input.checked) { e.preventDefault(); input.checked = false; sync(); }
  });
  picker.addEventListener("change", sync);
  sync();
}

/** Initials for an avatar circle ("Sam Supervisor" -> "SS"). */
export const initials = (name) =>
  String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/** Friendly empty state with a light line illustration. `action`: optional button HTML. */
export function emptyState(title, text = "", art = "check", action = "") {
  const arts = {
    check: '<svg viewBox="0 0 96 72"><rect x="14" y="10" width="68" height="52" rx="8" class="a1"/><path d="M26 24h30M26 34h22M26 44h26" class="a2"/><circle cx="70" cy="50" r="13" class="a3"/><path d="m64 50 4.5 4.5L77 46" class="a4"/></svg>',
    calendar: '<svg viewBox="0 0 96 72"><rect x="18" y="12" width="60" height="50" rx="8" class="a1"/><path d="M18 26h60M34 6v12M62 6v12" class="a2"/><circle cx="48" cy="44" r="10" class="a3"/><path d="M48 39v5l3 2" class="a4"/></svg>',
    chart: '<svg viewBox="0 0 96 72"><path d="M14 62h68" class="a2"/><rect x="22" y="36" width="12" height="26" rx="3" class="a1"/><rect x="42" y="22" width="12" height="40" rx="3" class="a1"/><rect x="62" y="44" width="12" height="18" rx="3" class="a3"/></svg>',
    search: '<svg viewBox="0 0 96 72"><circle cx="42" cy="32" r="18" class="a1"/><path d="m55 45 14 14" class="a4"/><path d="M34 32h16" class="a2"/></svg>',
    orders: '<svg viewBox="0 0 96 72"><rect x="24" y="10" width="48" height="56" rx="7" class="a1"/><rect x="38" y="5" width="20" height="10" rx="3" class="a3"/><path d="M34 30h28M34 40h20M34 50h24" class="a2"/><circle cx="73" cy="53" r="11" class="a3"/><path d="M73 47.5v11M67.5 53h11" class="a4"/></svg>',
    machine: '<svg viewBox="0 0 96 72"><rect x="12" y="24" width="56" height="34" rx="6" class="a1"/><path d="M12 58h64M22 24V14h20v10" class="a2"/><circle cx="72" cy="28" r="14" class="a3"/><circle cx="72" cy="28" r="5" class="a4"/><path d="M24 38h18M24 46h10" class="a2"/></svg>',
    users: '<svg viewBox="0 0 96 72"><circle cx="38" cy="26" r="11" class="a1"/><path d="M18 62c2-12 10-18 20-18s18 6 20 18" class="a1"/><circle cx="68" cy="30" r="8" class="a3"/><path d="M58 60c1-8 5-12 10-12s9 4 10 12" class="a4"/></svg>',
    photo: '<svg viewBox="0 0 96 72"><rect x="16" y="12" width="64" height="48" rx="7" class="a1"/><circle cx="34" cy="28" r="6" class="a3"/><path d="m18 56 18-16 12 12 8-6 22 12" class="a4"/></svg>',
  };
  return `<div class="empty empty-state fade-up" data-art="${esc(arts[art] ? art : "check")}">
    <div class="empty-state__art" aria-hidden="true">${arts[art] || arts.check}</div>
    <div class="empty__title">${esc(title)}</div>${text ? `<p>${esc(text)}</p>` : ""}
    ${action ? `<div class="empty-state__action">${action}</div>` : ""}
  </div>`;
}

export const emptyRow = (colspan, title, text = "", art = "search", action = "") =>
  `<tr class="empty-row"><td colspan="${colspan}">${emptyState(title, text, art, action)}</td></tr>`;

/** Failed-load state with a "Try again" button (views wire up [data-retry]). */
export function errorState(title, message, { retry = true } = {}) {
  return `<div class="empty empty-state error-state fade-up" role="alert">
    <div class="error-state__icon" aria-hidden="true">${icons.alert}</div>
    <div class="empty__title">${esc(title)}</div>${message ? `<p>${esc(message)}</p>` : ""}
    ${retry ? `<button class="btn btn--sm" type="button" data-retry>Try again</button>` : ""}
  </div>`;
}

export const errorRow = (colspan, title, message) =>
  `<tr class="empty-row"><td colspan="${colspan}">${errorState(title, message)}</td></tr>`;

export const option = (value, label, selected) =>
  `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

// ------------------------------------------------------------ toasts

export function toast(message, type = "ok") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast--error" : type === "warn" ? " toast--warn" : ""}`;
  const life = type === "error" ? 5200 : 3200;
  el.style.setProperty("--life", `${life}ms`);   // drives the countdown bar
  el.textContent = message;
  el.title = "Dismiss";
  root.appendChild(el);
  // Keep at most 3 on screen so they never bury the page.
  const live = [...root.children].filter((t) => !t.classList.contains("is-out"));
  live.slice(0, Math.max(0, live.length - 3)).forEach(dismissToast);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-in")));
  const timer = setTimeout(() => dismissToast(el), life);
  el.addEventListener("click", () => { clearTimeout(timer); dismissToast(el); });
}

function dismissToast(el) {
  if (el.classList.contains("is-out")) return;
  el.classList.add("is-out");
  el.classList.remove("is-in");
  const remove = () => el.remove();
  el.addEventListener("transitionend", (e) => { if (e.target === el) remove(); });
  setTimeout(remove, motionOK() ? 320 : 0);
}

// ------------------------------------------------------------ modals

const modalStack = [];

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalStack.length) modalStack[modalStack.length - 1].close();
});

/**
 * Open a modal. Returns { el, body, foot, setTitle, setEyebrow, setBody, setFoot, close }.
 * `onClose` runs once when it closes (by button, Esc, backdrop or close()).
 */
export function openModal({ title = "", eyebrow = "", body = "", foot = "", wide = false, danger = false, onClose } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal${wide ? " modal--wide" : ""}${danger ? " modal--danger" : ""}" role="dialog" aria-modal="true">
      <div class="modal__head">
        <div><div class="modal__eyebrow mono"></div><h2 class="modal__title"></h2></div>
        <button class="modal__close" type="button" aria-label="Close">${icons.close}</button>
      </div>
      <div class="modal__body"></div>
      <div class="modal__foot"></div>
    </div>`;
  document.getElementById("modal-root").appendChild(backdrop);
  document.body.classList.add("modal-open");

  const $ = (sel) => backdrop.querySelector(sel);
  let closed = false;
  const api = {
    el: backdrop,
    body: $(".modal__body"),
    foot: $(".modal__foot"),
    setTitle: (t) => { $(".modal__title").textContent = t; },
    setEyebrow: (t) => { $(".modal__eyebrow").textContent = t; $(".modal__eyebrow").hidden = !t; },
    /** Replace the body. animate: cross-fade the new content in (e.g. skeleton -> data). */
    setBody: (html, { animate = false } = {}) => {
      const b = $(".modal__body");
      b.innerHTML = html;
      if (animate && motionOK()) { b.classList.remove("content-in"); void b.offsetWidth; b.classList.add("content-in"); }
    },
    setFoot: (html) => { $(".modal__foot").innerHTML = html; $(".modal__foot").hidden = !html; },
    close() {
      if (closed) return;
      closed = true;
      modalStack.splice(modalStack.indexOf(api), 1);
      // Panel leaves first, backdrop fades just after (see .is-closing in CSS).
      backdrop.classList.remove("is-open");
      backdrop.classList.add("is-closing");
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        backdrop.remove();
        if (!modalStack.length) document.body.classList.remove("modal-open");
      };
      backdrop.addEventListener("transitionend", (e) => { if (e.target === backdrop) remove(); });
      setTimeout(remove, motionOK() ? 340 : 0);
      if (onClose) onClose();
    },
    get isClosed() { return closed; },
  };
  api.setTitle(title);
  api.setEyebrow(eyebrow);
  api.setBody(body);
  api.setFoot(foot);

  $(".modal__close").addEventListener("click", api.close);
  // Close on backdrop click (but not when a text selection drag ends there).
  let downOnBackdrop = false;
  backdrop.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener("click", (e) => { if (downOnBackdrop && e.target === backdrop) api.close(); });
  backdrop.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) api.close();
  });

  modalStack.push(api);
  requestAnimationFrame(() => {
    backdrop.classList.add("is-open");
    const first = backdrop.querySelector(".modal__body [autofocus], .modal__body input:not([type=hidden]):not([disabled]), .modal__body select, .modal__body textarea");
    if (first) first.focus({ preventScroll: true });
  });
  return api;
}

/** Yes/no confirmation. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const modal = openModal({
      title, danger,
      body: `<p style="margin:0">${esc(message)}</p>`,
      foot: `<button class="btn" data-close>Cancel</button>
             <button class="btn ${danger ? "btn--danger" : "btn--primary"}" data-confirm>${esc(confirmLabel)}</button>`,
      onClose: () => resolve(result),
    });
    modal.foot.querySelector("[data-confirm]").addEventListener("click", () => { result = true; modal.close(); });
    modal.foot.querySelector("[data-confirm]").focus();
  });
}

// ------------------------------------------------------------ forms

export const loadingBlock = `<div class="loading-line"></div>${skeletonBlock(4)}`;

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") values[el.name] = el.checked;
    else values[el.name] = el.value.trim();
  }
  return values;
}

export function clearErrors(form) {
  form.querySelectorAll(".field.has-error").forEach((f) => f.classList.remove("has-error"));
  form.querySelectorAll(".field__error").forEach((e) => { e.textContent = ""; });
  const top = form.querySelector(".form__error");
  if (top) top.textContent = "";
}

export function showErrors(form, errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const input = form.elements[name];
    const field = input && (input.closest ? input.closest(".field") : null);
    if (field) {
      field.classList.add("has-error");
      const slot = field.querySelector(".field__error");
      if (slot) slot.textContent = message;
      first = first || input;
    } else {
      setFormError(form, message);
    }
  }
  if (first) first.focus();
  return Object.keys(errors).length === 0;
}

export function setFormError(form, message) {
  const top = form.querySelector(".form__error");
  if (top) top.textContent = message;
  else toast(message, "error");
}

/** Show a server error on the form - on the named field if the message names one. */
export function showServerError(form, err) {
  const match = /'([a-z_]+)'/.exec(err.message || "");
  if (match && form.elements[match[1]] && form.elements[match[1]].closest) {
    showErrors(form, { [match[1]]: err.message.replace(/'([a-z_]+)'/, (m, f) => labelFor(form, f)) });
  } else {
    setFormError(form, err.message);
  }
}

function labelFor(form, name) {
  const input = form.elements[name];
  const label = input && input.id && form.querySelector(`label[for="${input.id}"]`);
  return label ? label.textContent.replace(/\s*\*$/, "") : name;
}

/** Run an async action with the button showing a spinner and disabled. */
export async function withBusy(button, fn) {
  if (!button || button.classList.contains("is-busy")) return;
  button.classList.add("is-busy");
  button.disabled = true;
  try { return await fn(); }
  finally { button.classList.remove("is-busy"); button.disabled = false; }
}

// Small validators returning an error message or "".
export const check = {
  required: (v, label = "This field") => (v === "" || v === null || v === undefined) ? `${label} is required` : "",
  maxLen: (v, n) => (v && v.length > n) ? `Must be at most ${n} characters` : "",
  decimal(v, { min = 0, max = Infinity, positive = false } = {}) {
    if (v === "") return "";
    if (!/^-?\d+(\.\d{1,2})?$/.test(v)) return "Enter a number with at most 2 decimal places";
    const n = Number(v);
    if (positive && n <= 0) return "Must be greater than 0";
    if (n < min) return `Must be at least ${min}`;
    if (n > max) return `Must be at most ${max}`;
    return "";
  },
  email: (v) => (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) ? "Enter a valid email address" : "",
};

/** Build an errors object from { field: [message, ...] } keeping the first non-empty. */
export function collect(rules) {
  const errors = {};
  for (const [field, messages] of Object.entries(rules)) {
    const first = messages.find(Boolean);
    if (first) errors[field] = first;
  }
  return errors;
}

/** Standard form field markup. */
export function field({ name, label, type = "text", value = "", required = false, hint = "", attrs = "", span = false, options = null, id = null }) {
  const fid = id || `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  let control;
  if (options !== null) {
    control = `<select id="${fid}" name="${name}" ${attrs}>${options}</select>`;
  } else if (type === "textarea") {
    control = `<textarea id="${fid}" name="${name}" ${attrs}>${esc(value)}</textarea>`;
  } else {
    control = `<input id="${fid}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
  }
  return `<div class="field${span ? " span-2" : ""}">
    <label for="${fid}">${esc(label)}${required ? " *" : ""}</label>
    ${control}
    ${hint ? `<div class="field__hint">${esc(hint)}</div>` : ""}
    <div class="field__error"></div>
  </div>`;
}
