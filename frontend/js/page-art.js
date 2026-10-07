// Page-header decoration: a small icon mark beside the title (the same glyph
// as the nav link) and a faint line-art vignette on the right of the header,
// drawn in the sign-in page's vocabulary (gears, gauge, amber accents).
import { icons } from "./ui.js";

/** Gear outline centred on 0,0: n trapezoid teeth between radius r and R, plus a hub. */
function gear(R, r, n, hub) {
  const step = (Math.PI * 2) / n, pts = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    for (const [f, rad] of [[-0.3, r], [-0.16, R], [0.16, R], [0.3, r]]) {
      pts.push(`${(Math.cos(a + f * step) * rad).toFixed(1)} ${(Math.sin(a + f * step) * rad).toFixed(1)}`);
    }
  }
  return `<path d="M${pts.join("L")}Z"/><circle r="${hub}"/>`;
}

// Gears spin with the sign-in page's .lg-gear (slow, and off under reduced motion).
const spin = (x, y, g, rev = false) => `<g transform="translate(${x} ${y})"><g class="lg-gear${rev ? " lg-gear--rev" : ""}">${g}</g></g>`;

const ART = {
  // Gauge with an idling needle, a small gear and a trend line feeding into it.
  dashboard: `
    <path class="pa-soft" d="M8 74h232"/>
    <path d="M14 66l18-10 16 6 18-16 16 4"/><circle class="pa-dot" cx="82" cy="50" r="2.6"/>
    <g transform="translate(150 70)">
      <path d="M-50 0A50 50 0 0 1 50 0"/><path class="pa-soft" d="M-40 0A40 40 0 0 1 40 0"/>
      <path class="pa-amber" d="M28.3-28.3A40 40 0 0 1 40 0"/>
      <path d="M-50 0h7M0-50v7M50 0h-7M-35.4-35.4l5 5M35.4-35.4l-5 5"/>
      <g class="lg-needle"><path d="M0 5V-34"/></g><circle class="pa-dot" r="3.5"/>
    </g>
    ${spin(218, 30, gear(17, 12.5, 9, 5), true)}`,
  // Clipboard checklist (first item ticked in amber) with a wrench leaning on it.
  "work-orders": `
    <path class="pa-soft" d="M8 80h232"/>
    <rect x="112" y="10" width="68" height="70" rx="6"/><rect x="132" y="4" width="28" height="12" rx="3"/>
    <path class="pa-amber" d="M124 32l4 4 7-8"/><path d="M142 32h26"/>
    <rect x="124" y="45" width="9" height="9" rx="2"/><path d="M142 50h22"/>
    <rect x="124" y="61" width="9" height="9" rx="2"/><path d="M142 66h18"/>
    <path d="M196 74l26-26m4.5-14.5a10 10 0 0 0-12.6 12.6l-17.4 17.4a4 4 0 0 0 5.6 5.6l17.4-17.4a10 10 0 0 0 12.6-12.6l-6 6-5.6-1.4-1.4-5.6z"/>
    <path class="pa-soft" d="M30 64h56M46 52h40"/>`,
  // Two meshing gears on a dashed base line.
  machines: `
    <path class="pa-soft" d="M8 82h232"/>
    ${spin(156, 46, gear(32, 25, 12, 9))}
    ${spin(203.5, 27.5, gear(18, 13, 8, 5), true)}
    <circle class="pa-amber" cx="156" cy="46" r="3"/>
    <path class="pa-soft" d="M40 66h70M64 54h46"/>`,
  // A crew: three head-and-shoulders, the middle one in an amber hard hat.
  users: `
    <path class="pa-soft" d="M8 82h232"/>
    <circle cx="118" cy="44" r="10"/><path d="M98 80c1.5-12 9-19 20-19s18.5 7 20 19"/>
    <circle cx="210" cy="44" r="10"/><path d="M190 80c1.5-12 9-19 20-19s18.5 7 20 19"/>
    <path d="M156.4 30A11 11 0 1 0 171.6 30"/><path d="M140 80c2-15 11-23 24-23s22 8 24 23"/>
    <path class="pa-amber" d="M151 30a13 13 0 0 1 26 0M147 30h34M164 17v6"/>
    <path class="pa-soft" d="M34 66h50M52 54h32"/>`,
  // Clock face beside a timeline of events.
  activity: `
    <path class="pa-soft" d="M8 80h232"/>
    <g transform="translate(200 44)"><circle r="28"/><path class="pa-soft" d="M0-20v4M20 0h-4M0 20v-4M-20 0h4"/>
      <path class="pa-amber" d="M0 0V-15M0 0l10 6"/><circle class="pa-dot" r="2.6"/></g>
    <path d="M60 60h104"/><circle cx="78" cy="60" r="4"/><circle cx="112" cy="60" r="4"/><circle class="pa-dot" cx="146" cy="60" r="4.5"/>
    <path class="pa-soft" d="M78 50v-12M112 50v-20M146 50v-14"/>`,
};

const MARK = { dashboard: icons.dashboard, "work-orders": icons.orders, machines: icons.machine, users: icons.users, activity: icons.activity };

let current = null;

/** Show the decoration for a page key (or none). Replays the entrance only when the page changes. */
export function setPageArt(key) {
  if (key === current) return;
  current = key;
  const mark = document.getElementById("page-mark"), art = document.getElementById("page-art");
  const has = !!(key && MARK[key]);
  mark.hidden = art.hidden = !has;
  if (!has) { mark.innerHTML = art.innerHTML = ""; return; }
  mark.innerHTML = MARK[key];
  art.innerHTML = `<svg viewBox="0 0 240 88" focusable="false">${ART[key]}</svg>`;
  for (const n of [mark, art]) { n.classList.remove("is-in"); void n.offsetWidth; n.classList.add("is-in"); }
}
