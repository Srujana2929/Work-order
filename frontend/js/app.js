// App bootstrap: session check, login, navigation rail, hash router.
import { api, setUnauthorizedHandler } from "./api.js";
import { session, can, isAdmin } from "./session.js";
import {
  APP_TITLE, check, clearErrors, collect, esc, field, formValues, icons, initials, openModal,
  setPage, showErrors, showServerError, toast, withBusy,
} from "./ui.js";
import { replayEnter, swapContent } from "./motion.js";
import "./theme.js";
import { closeMenus, initTopbar, refreshAlerts, renderUser, resetTopbar } from "./topbar.js";
import dashboardView from "./views/dashboard.js";
import workOrdersView from "./views/work-orders.js";
import machinesView from "./views/machines.js";
import usersView from "./views/users.js";
import activityView from "./views/activity.js";

const ROUTES = {
  "dashboard":   { view: dashboardView,  label: "Dashboard",    icon: icons.dashboard, section: "Operations",     allowed: () => can("dashboard:view") },
  "work-orders": { view: workOrdersView, label: "Work Orders",  icon: icons.orders,    section: "Operations",     allowed: () => can("work_orders:view") },
  "machines":    { view: machinesView,   label: "Machines",     icon: icons.machine,   section: "Operations",     allowed: () => can("machines:view") },
  "users":       { view: usersView,      label: "Users",        icon: icons.users,     section: "Administration", allowed: () => isAdmin() },
  "activity":    { view: activityView,   label: "Activity Log", icon: icons.activity,  section: "Administration", allowed: () => can("audit:view") },
};

const el = (id) => document.getElementById(id);
let current = { name: null, instance: null };

// ------------------------------------------------------------------ boot

setUnauthorizedHandler((message) => {
  if (session.user) {
    toast(/deactivated/i.test(message || "") ? "Your account has been deactivated." : "Your session has ended - please sign in again.", "warn");
    showLogin();
  }
});

// Connection status and unexpected failures: never fail silently.
window.addEventListener("offline", () => toast("You're offline. Changes can't be saved until the connection returns.", "warn"));
window.addEventListener("online", () => toast("Back online."));
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : "Unexpected error";
  console.error(e.reason);
  toast(`Something went wrong: ${msg}`, "error");
});

async function boot() {
  try {
    const { user } = await api("/auth/me");
    session.user = user;
    showApp();
  } catch {
    showLogin();
  } finally {
    el("boot").hidden = true;
  }
}

// ------------------------------------------------------------------ login

function showLogin() {
  session.user = null;
  closeMenus();
  setNavOpen(false);
  unmountCurrent();
  // Nothing from the previous user may survive into the next session:
  // page content, remembered filters/tabs, alerts, search.
  el("view").innerHTML = "";
  el("page-title").textContent = "";
  el("page-crumb").innerHTML = "";
  document.title = APP_TITLE;
  Object.values(ROUTES).forEach((r) => r.view.reset && r.view.reset());
  resetTopbar();
  document.getElementById("modal-root").innerHTML = "";
  document.body.classList.remove("modal-open");
  el("app").hidden = true;
  el("login-screen").hidden = false;
  const form = el("login-form");
  form.reset();
  clearErrors(form);
  setReveal(false);
  const remembered = storage.get(REMEMBER_KEY);
  if (remembered) { form.elements.username.value = remembered; el("login-remember").checked = true; }
  setTimeout(() => (remembered ? form.elements.password : form.elements.username).focus(), 50);
}

// "Remember me" only pre-fills the username on this device; it is not sent to the API.
const REMEMBER_KEY = "wo.rememberUser";
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

function setReveal(show) {
  const btn = el("login-reveal");
  el("login-password").type = show ? "text" : "password";
  btn.setAttribute("aria-pressed", String(show));
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
}

el("login-reveal").addEventListener("click", () => {
  setReveal(el("login-password").type === "password");
  el("login-password").focus();
});

el("login-forgot").addEventListener("click", (e) => {
  e.preventDefault();
  toast("Password resets are handled by an administrator - contact your Admin, or support@workorder.app.");
});

el("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  const v = formValues(form);
  const errors = collect({
    username: [check.required(v.username, "Username")],
    password: [check.required(v.password, "Password")],
  });
  if (!showErrors(form, errors)) return;

  withBusy(form.querySelector("button[type=submit]"), async () => {
    try {
      const { user } = await api("/auth/login", { method: "POST", body: v });
      session.user = user;
      storage.set(REMEMBER_KEY, el("login-remember").checked ? v.username : "");
      el("login-screen").hidden = true;
      showApp();
      toast(`Signed in as ${user.full_name}`);
    } catch (err) {
      form.querySelector(".form__error").textContent = err.message;
      form.elements.password.value = "";
      form.elements.password.focus();
    }
  });
});

async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* cookie cleared or already gone */ }
  if (location.hash) history.replaceState(null, "", location.pathname);
  showLogin();
}

// ------------------------------------------------------------------ shell

function showApp() {
  el("login-screen").hidden = true;
  el("app").hidden = false;
  renderRail();
  renderUser();
  refreshAlerts(true);
  if (!location.hash || location.hash === "#/") location.hash = "#/dashboard";
  else route();
}

function renderRail() {
  const u = session.user;
  // Group links under their section label; a label only appears if the user can see a link in it.
  let lastSection = null;
  el("nav").innerHTML = Object.entries(ROUTES)
    .filter(([, r]) => r.allowed())
    .map(([name, r]) => {
      const header = r.section !== lastSection ? `<div class="rail__section">${esc(r.section)}</div>` : "";
      lastSection = r.section;
      return `${header}<a class="nav-link" href="#/${name}" data-route="${name}">${r.icon}<span>${r.label}</span></a>`;
    }).join("");

  el("rail-user").innerHTML = `
    <div class="rail__user-name"><span class="avatar avatar--rail" aria-hidden="true">${esc(initials(u.full_name))}</span>${esc(u.full_name)}</div>
    <div class="rail__user-meta"><span class="role-tag">${esc(u.role)}</span> ${esc(u.username)}${u.department ? " · " + esc(u.department) : ""}</div>
    ${u.role === "Technician" ? `<div class="rail__rating" data-my-rating hidden></div>` : ""}
    <div class="rail__user-actions">
      <button type="button" data-action="password">Password</button>
      <button type="button" data-action="logout">Sign out</button>
    </div>`;
  el("rail-user").querySelector('[data-action="logout"]').onclick = logout;
  el("rail-user").querySelector('[data-action="password"]').onclick = () => { setNavOpen(false); openChangePassword(); };
}

// ------------------------------------------------------------------ mobile nav drawer
// Below 821px the rail collapses to a bar with a hamburger; nav + account
// actions live in a slide-out drawer. Desktop never sees any of this.

const mobileNav = window.matchMedia("(max-width: 820px)");

function setNavOpen(open) {
  const drawer = el("rail-drawer");
  const toggle = el("nav-toggle");
  open = open && mobileNav.matches;
  document.body.classList.toggle("nav-open", open);
  el("nav-backdrop").hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  // Closed drawer is off-screen on mobile: keep it out of the tab order there.
  drawer.inert = mobileNav.matches && !open;
  if (open) (drawer.querySelector(".nav-link.is-active") || drawer.querySelector("a, button"))?.focus();
}

el("nav-toggle").addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
el("nav-backdrop").addEventListener("click", () => setNavOpen(false));
el("nav").addEventListener("click", (e) => { if (e.target.closest(".nav-link")) setNavOpen(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) { setNavOpen(false); el("nav-toggle").focus(); }
});
mobileNav.addEventListener("change", () => setNavOpen(false));
setNavOpen(false);

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  el("clock").innerHTML = `<b>${time}</b>${date}`;
}
tickClock();
setInterval(tickClock, 1000);

// ------------------------------------------------------------------ router

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const [name, ...params] = pathPart.split("/").filter(Boolean);
  return { name: name || "dashboard", params, query: Object.fromEntries(new URLSearchParams(queryPart)) };
}

function unmountCurrent() {
  // Cancel any view transition still in flight so it can't mount afterwards.
  const viewEl = el("view");
  viewEl._swapToken = (viewEl._swapToken || 0) + 1;
  viewEl.classList.remove("view-leave");
  if (current.instance && current.instance.destroy) current.instance.destroy();
  current = { name: null, instance: null };
}

function route() {
  if (!session.user) return;
  closeMenus();
  refreshAlerts();      // throttled; keeps the bell current as you move around
  const { name, params, query } = parseHash();
  const entry = ROUTES[name];

  document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("is-active", a.dataset.route === name));

  if (!entry) { location.hash = "#/dashboard"; return; }

  const viewEl = el("view");
  if (!entry.allowed()) {
    unmountCurrent();
    setPage("Not authorised");
    viewEl.innerHTML = `<div class="panel"><div class="empty"><div class="empty__title">Not authorised</div>Your role (${esc(session.user.role)}) cannot open this page.</div></div>`;
    replayEnter(viewEl);
    return;
  }

  // Same view, new params (e.g. opening a work order): let the view handle it.
  if (current.name === name && current.instance && current.instance.update) {
    current.instance.update(params, query);
    return;
  }
  // Slide in the direction of travel through the nav order.
  const order = Object.keys(ROUTES);
  const dir = current.name ? Math.sign(order.indexOf(name) - order.indexOf(current.name)) : 0;
  swapContent(viewEl, () => {
    if (current.instance && current.instance.destroy) current.instance.destroy();
    viewEl.innerHTML = "";
    current = { name, instance: entry.view.mount(viewEl, params, query) || {} };
    window.scrollTo(0, 0);
  }, { dir });
}

// Global activity bar: shown only when a request takes longer than ~150 ms.
let busyTimer = null;
window.addEventListener("api:activity", (e) => {
  const bar = el("busy-bar");
  clearTimeout(busyTimer);
  if (e.detail > 0) busyTimer = setTimeout(() => bar.classList.add("is-active"), 150);
  else bar.classList.remove("is-active");
});

window.addEventListener("hashchange", route);
window.addEventListener("hashchange", () => setNavOpen(false));
initTopbar({ logout, changePassword: openChangePassword });

// ------------------------------------------------------------------ change password

function openChangePassword() {
  const modal = openModal({
    title: "Change password",
    eyebrow: session.user.username,
    body: `<form class="form" novalidate>
      <div class="form__error" role="alert"></div>
      ${field({ name: "current_password", label: "Current password", type: "password", required: true, attrs: 'autocomplete="current-password"' })}
      ${field({ name: "new_password", label: "New password", type: "password", required: true, hint: "At least 8 characters.", attrs: 'autocomplete="new-password"' })}
      ${field({ name: "confirm", label: "Confirm new password", type: "password", required: true, attrs: 'autocomplete="new-password"' })}
    </form>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-save>Change password</button>`,
  });
  const form = modal.body.querySelector("form");
  const save = () => {
    clearErrors(form);
    const v = formValues(form);
    const errors = collect({
      current_password: [check.required(v.current_password, "Current password")],
      new_password: [check.required(v.new_password, "New password"),
                     v.new_password.length < 8 ? "Must be at least 8 characters" : ""],
      confirm: [v.confirm !== v.new_password ? "Passwords do not match" : ""],
    });
    if (!showErrors(form, errors)) return;
    withBusy(modal.foot.querySelector("[data-save]"), async () => {
      try {
        await api("/auth/change-password", { method: "POST",
          body: { current_password: v.current_password, new_password: v.new_password } });
        modal.close();
        toast("Password changed. Other sessions have been signed out.");
      } catch (err) { showServerError(form, err); }
    });
  };
  modal.foot.querySelector("[data-save]").onclick = save;
  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
}

boot();
