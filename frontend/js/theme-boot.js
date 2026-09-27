// Runs synchronously in <head>, before first paint, so a dark-theme user never
// sees a flash of the light theme. The toggle itself lives in theme.js.
(function () {
  var theme = null;
  try { theme = localStorage.getItem("wo-theme"); } catch (e) { /* storage blocked */ }
  if (theme !== "dark" && theme !== "light") {
    theme = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
})();
