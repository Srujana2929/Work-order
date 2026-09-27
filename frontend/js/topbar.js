// Top bar: global search, alerts bell, user menu.
// All data comes from the existing API (work orders, machines, dashboard summary).
import { api } from "./api.js";
import { can, isTechnician, session } from "./session.js";
import { debounce, esc, fmt, icons, initials, statusBadge } from "./ui.js";

const $ = (id) => document.getElementById(id);
let handlers = { logout: () => {}, changePassword: () => {} };
let openPanel = null;          // { button, panel }
let alertsFetchedAt = 0;

// ------------------------------------------------------------------ dropdown plumbing

function showPanel(button, panel) {
  if (openPanel && openPanel.panel !== panel) hidePanel();
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("is-open"));
  if (button) button.setAttribute("aria-expanded", "true");
  openPanel = { button, panel };
}

function hidePanel() {
  if (!openPanel) return;
  const { button, panel } = openPanel;
  openPanel = null;
  panel.classList.remove("is-open");
  if (button) button.setAttribute("aria-expanded", "false");
  setTimeout(() => { if (!panel.classList.contains("is-open")) panel.hidden = true; }, 160);
}

export function closeMenus() { hidePanel(); }

/** Clear everything user-specific (on sign-out). */
export function resetTopbar() {
  hidePanel();
  alertsFetchedAt = 0;
  $("bell-dot").hidden = true;
  $("bell-menu").innerHTML = "";
  $("user-chip").innerHTML = "";
  $("user-menu").innerHTML = "";
  $("gsearch-input").value = "";
  $("gsearch-results").innerHTML = "";
}

document.addEventListener("click", (e) => {
  if (openPanel && !e.target.closest(".menu-wrap, .gsearch")) hidePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPanel) { hidePanel(); return; }
  // "/" focuses search (unless typing in a field).
  if (e.key === "/" && !e.target.closest("input, textarea, select, [contenteditable]") && !document.body.classList.contains("modal-open")) {
    e.preventDefault();
    $("gsearch-input").focus();
  }
});

// ------------------------------------------------------------------ init

export function initTopbar({ logout, changePassword }) {
  handlers = { logout, changePassword };
  initSearch();
  $("bell").addEventListener("click", () => {
    if (openPanel && openPanel.panel === $("bell-menu")) { hidePanel(); return; }
    showPanel($("bell"), $("bell-menu"));
    refreshAlerts(true);
  });
  $("user-chip").addEventListener("click", () => {
    if (openPanel && openPanel.panel === $("user-menu")) hidePanel();
    else showPanel($("user-chip"), $("user-menu"));
  });
  $("user-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-menu]");
    if (!item) return;
    hidePanel();
    if (item.dataset.menu === "logout") handlers.logout();
    if (item.dataset.menu === "password") handlers.changePassword();
  });
  $("bell-menu").addEventListener("click", (e) => { if (e.target.closest("a")) hidePanel(); });
}

// ------------------------------------------------------------------ user chip + menu

export function renderUser() {
  const u = session.user;
  const avatar = `<span class="avatar" aria-hidden="true">${esc(initials(u.full_name))}</span>`;
  $("user-chip").innerHTML = `${avatar}
    <span class="user-chip__text"><b>${esc(u.full_name)}</b><span class="role-tag role-tag--${esc(u.role.toLowerCase())}">${esc(u.role)}</span></span>
    <span class="user-chip__caret">${icons.chevronDown}</span>`;
  $("user-menu").innerHTML = `
    <div class="user-menu__head">
      <span class="avatar avatar--lg" aria-hidden="true">${esc(initials(u.full_name))}</span>
      <div><b>${esc(u.full_name)}</b><div class="muted mono">${esc(u.email)}</div>
      <span class="role-tag role-tag--${esc(u.role.toLowerCase())}">${esc(u.role)}</span>${u.department ? ` <span class="muted">· ${esc(u.department)}</span>` : ""}</div>
    </div>
    <button class="dropdown__item" type="button" data-menu="password">${icons.key}<span>Change password</span></button>
    <button class="dropdown__item dropdown__item--danger" type="button" data-menu="logout">${icons.logout}<span>Sign out</span></button>`;
}

// ------------------------------------------------------------------ alerts (bell)

/** Refresh alert counts from the dashboard summary (throttled unless forced). */
export async function refreshAlerts(force = false) {
  if (!session.user || !can("dashboard:view")) return;
  if (!force && Date.now() - alertsFetchedAt < 20000) return;
  alertsFetchedAt = Date.now();
  let s;
  try { s = await api("/dashboard/summary"); } catch { return; }
  if (!session.user) return;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const b = s.by_status;
  const items = [];
  if (s.overdue) items.push({ tone: "var(--red)", icon: "alert", text: plural(s.overdue, "work order is overdue", "work orders are overdue"), href: "#/work-orders?overdue=true" });
  if (isTechnician()) {
    if (b["Assigned"]) items.push({ tone: "var(--blue)", icon: "inbox", text: `${plural(b["Assigned"], "work order", "work orders")} assigned to you, not started`, href: "#/work-orders?status=Assigned" });
    if (b["On Hold"]) items.push({ tone: "var(--rust)", icon: "clock", text: `${plural(b["On Hold"], "work order", "work orders")} on hold`, href: "#/work-orders?status=On Hold" });
  } else {
    if (can("work_orders:assign") && b["Pending"]) items.push({ tone: "var(--amber)", icon: "inbox", text: `${plural(b["Pending"], "work order", "work orders")} waiting for a technician`, href: "#/work-orders?status=Pending" });
    if (can("work_orders:verify") && b["Completed"]) items.push({ tone: "var(--green)", icon: "check", text: `${plural(b["Completed"], "work order", "work orders")} awaiting verification`, href: "#/work-orders?status=Completed" });
  }

  $("bell-dot").hidden = items.length === 0;
  $("bell").setAttribute("aria-label", items.length ? `Alerts (${items.length})` : "Alerts");
  $("bell-menu").innerHTML = `
    <div class="dropdown__head"><b>Alerts</b><span class="muted mono">${items.length ? `${items.length} active` : "all clear"}</span></div>
    ${items.length ? items.map((i) => `
      <a class="dropdown__item alert-item" href="${i.href}">
        <span class="icon-badge icon-badge--sm" style="--tone:${i.tone}">${icons[i.icon]}</span><span>${esc(i.text)}</span>
        <span class="alert-item__go">${icons.chevronRight}</span>
      </a>`).join("")
      : `<div class="dropdown__empty">${icons.check}<span>You're all caught up.</span></div>`}`;
}

// ------------------------------------------------------------------ global search

function initSearch() {
  const input = $("gsearch-input");
  const box = $("gsearch-results");
  let seq = 0;
  let activeIndex = -1;

  const items = () => [...box.querySelectorAll(".dropdown__item")];
  const setActive = (i) => {
    const list = items();
    activeIndex = list.length ? (i + list.length) % list.length : -1;
    list.forEach((el, n) => el.classList.toggle("is-active", n === activeIndex));
    if (activeIndex >= 0) list[activeIndex].scrollIntoView({ block: "nearest" });
  };
  const close = () => {
    input.setAttribute("aria-expanded", "false");
    if (openPanel && openPanel.panel === box) hidePanel();
  };
  const goAll = (q) => { location.hash = `#/work-orders?q=${encodeURIComponent(q)}`; };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const mine = ++seq;
    box.innerHTML = `<div class="dropdown__empty"><span class="spinner"></span><span>Searching…</span></div>`;
    if (!openPanel || openPanel.panel !== box) showPanel(null, box);
    input.setAttribute("aria-expanded", "true");
    try {
      const [wo, mc] = await Promise.all([
        api("/work-orders", { query: { q, per_page: 5 } }),
        can("machines:view") ? api("/machines", { query: { q, per_page: 5 } }) : Promise.resolve({ machines: [] }),
      ]);
      if (mine !== seq) return;
      let html = "";
      if (wo.work_orders.length) {
        html += `<div class="dropdown__group">Work orders <span class="mono">${wo.pagination.total}</span></div>` +
          wo.work_orders.map((w) => `<a class="dropdown__item" role="option" href="#/work-orders/${w.id}">
              <span class="mono muted">${fmt.woId(w.id)}</span><span class="dropdown__title">${esc(w.title)}</span>${statusBadge(w.status)}</a>`).join("");
      }
      if (mc.machines.length) {
        html += `<div class="dropdown__group">Machines <span class="mono">${mc.pagination.total}</span></div>` +
          mc.machines.map((m) => `<a class="dropdown__item" role="option" href="#/machines/${m.id}">
              <span class="mono muted">${esc(m.machine_code)}</span><span class="dropdown__title">${esc(m.name)}</span><span class="muted">${esc(m.department)}</span></a>`).join("");
      }
      if (!html) {
        html = `<div class="dropdown__empty">${icons.search}<span>No work orders or machines match “${esc(q)}”.</span></div>`;
      } else if (wo.pagination.total > wo.work_orders.length) {
        html += `<a class="dropdown__item dropdown__all" role="option" href="#/work-orders?q=${encodeURIComponent(q)}">See all ${wo.pagination.total} matching work orders ${icons.chevronRight}</a>`;
      }
      box.innerHTML = html;
      activeIndex = -1;
    } catch (err) {
      if (mine === seq) box.innerHTML = `<div class="dropdown__empty">${esc(err.message)}</div>`;
    }
  }, 220);

  input.addEventListener("input", run);
  input.addEventListener("focus", () => { if (input.value.trim().length >= 2 && box.innerHTML) showPanel(null, box); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const target = items()[activeIndex];
      const q = input.value.trim();
      if (target) location.hash = target.getAttribute("href");
      else if (q) goAll(q);
      input.value = ""; close(); input.blur();
    } else if (e.key === "Escape") { input.value = ""; close(); input.blur(); }
  });
  box.addEventListener("click", (e) => {
    if (e.target.closest("a")) { input.value = ""; close(); }
  });
}
