// Light/dark theme: toggle, persistence, animated switch.
// Any element with [data-theme-toggle] acts as a toggle button. Views that
// paint with computed colours (charts) listen for the "themechange" event.
import { motionOK } from "./motion.js";

const KEY = "wo-theme";
const root = document.documentElement;
const osDark = window.matchMedia("(prefers-color-scheme: dark)");
let fallbackTimer = null;

function stored() {
  try { const t = localStorage.getItem(KEY); return t === "dark" || t === "light" ? t : null; }
  catch { return null; }
}
function save(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode etc. - preference just won't persist */ }
}

export function currentTheme() {
  return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function syncButtons() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    b.setAttribute("aria-label", `Switch to ${next} theme`);
    b.title = `Switch to ${next} theme`;
  });
}

function apply(theme) {
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  syncButtons();
  window.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

export function setTheme(theme) {
  if (theme === currentTheme()) return;
  if (!motionOK()) { apply(theme); return; }
  // Cross-fade the whole page where supported; otherwise transition colours.
  if (document.startViewTransition) { document.startViewTransition(() => apply(theme)); return; }
  root.classList.add("theme-anim");
  apply(theme);
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => root.classList.remove("theme-anim"), 320);
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  save(next);
  setTheme(next);
}

// Follow the OS setting until the user picks a theme explicitly.
osDark.addEventListener("change", (e) => { if (!stored()) setTheme(e.matches ? "dark" : "light"); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-theme-toggle]")) toggleTheme(); });
syncButtons();
