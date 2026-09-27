// Motion layer: the few animations CSS can't do on its own.
//   - renderRows():   keyed table-row updates (leave: fade + collapse, enter: fade-up, move: FLIP)
//   - captureMorph()/applyMorph(): re-render without losing state transitions (status lamps,
//                     priority bars, progress fills, workflow steps, cost counters)
//   - countUp():      numbers counting to their value
//   - swapContent():  leave/enter transition when a view's content is replaced
//   - skeletons:      placeholder markup while the API responds
// Everything checks prefers-reduced-motion and degrades to an instant update.

const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
export const motionOK = () => !reduceQuery.matches;

const EASE_OUT = "cubic-bezier(.16, 1, .3, 1)";
const EASE_IN = "cubic-bezier(.4, 0, 1, 1)";
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ table rows

function enterRow(tr, delay = 0) {
  tr.animate(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 220, delay, easing: EASE_OUT, fill: "backwards" },
  );
}

function leaveRow(tr) {
  // Drop the key at once so selectors/handlers only see live rows.
  tr.dataset.leavingId = tr.dataset.id || "";
  delete tr.dataset.id;
  tr.classList.add("row-leave");
  const cells = [...tr.children];
  const anims = [tr.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_IN, fill: "forwards" })];
  for (const td of cells) {
    // Table rows can't animate height directly: collapse each cell's content + padding.
    const wrap = document.createElement("div");
    wrap.className = "row-collapse";
    wrap.append(...td.childNodes);
    td.append(wrap);
    const cs = getComputedStyle(td);
    anims.push(wrap.animate([{ height: `${wrap.offsetHeight}px` }, { height: "0px" }], { duration: 220, easing: EASE_OUT, fill: "forwards" }));
    anims.push(td.animate(
      [{ paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom }, { paddingTop: "0px", paddingBottom: "0px" }],
      { duration: 220, easing: EASE_OUT, fill: "forwards" },
    ));
  }
  Promise.all(anims.map((a) => a.finished)).catch(() => {}).finally(() => tr.remove());
}

/** Fade + collapse one table row, then remove it. Resolves when done. */
export function collapseRow(tr) {
  if (!motionOK()) { tr.remove(); return Promise.resolve(); }
  return new Promise((resolve) => {
    leaveRow(tr);
    setTimeout(resolve, 240);
  });
}

/**
 * Replace a <tbody>'s rows with `html`, animating the difference.
 * Rows are matched by data-id: new ones fade in, missing ones fade + collapse,
 * kept ones glide to their new position and morph any changed state.
 * Options: highlight - data-id of a row to mark as newly created.
 */
export function renderRows(tbody, html, { highlight = null } = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const incoming = [...tpl.content.children];
  incoming.forEach((r) => { r._src = r.outerHTML; });

  const live = [...tbody.children].filter((r) => !r.classList.contains("row-leave"));
  if (!motionOK()) {
    tbody.replaceChildren(...incoming);
    markNew(tbody, highlight);
    return;
  }

  const oldByKey = new Map(live.filter((r) => r.dataset.id).map((r) => [r.dataset.id, r]));
  const freshTable = oldByKey.size === 0;           // first load / from skeleton or empty state
  const firstTop = new Map([...oldByKey].map(([k, r]) => [k, r.getBoundingClientRect().top]));
  const incomingKeys = new Set(incoming.map((r) => r.dataset.id).filter(Boolean));

  // Leaving: keyed rows no longer present collapse in place; unkeyed rows (skeleton,
  // empty state, error) are simply removed.
  for (const r of live) {
    if (r.dataset.id && incomingKeys.has(r.dataset.id)) continue;
    if (r.dataset.id) leaveRow(r); else r.remove();
  }

  // Place rows in their final order, reusing kept elements.
  const finals = incoming.map((n) => {
    const kept = n.dataset.id && oldByKey.get(n.dataset.id);
    if (!kept) return { el: n, isNew: true };
    if (kept._src !== n._src) {
      const snap = captureMorph(kept);
      kept.className = n.className;
      kept.innerHTML = n.innerHTML;
      kept._src = n._src;
      applyMorph(kept, snap);
      const wash = getComputedStyle(document.documentElement).getPropertyValue("--amber-wash").trim();
      kept.animate([{ backgroundColor: wash }, { backgroundColor: "transparent" }], { duration: 300, easing: "ease-out" });
    }
    return { el: kept, isNew: false };
  });
  let prev = null;
  for (const { el } of finals) {
    let anchor = prev ? prev.nextElementSibling : tbody.firstElementChild;
    while (anchor && anchor.classList.contains("row-leave") && anchor !== el) anchor = anchor.nextElementSibling;
    if (anchor !== el) tbody.insertBefore(el, anchor);
    prev = el;
  }

  // Animate: FLIP for moved rows, fade-up for new ones (staggered on a fresh table).
  let stagger = 0;
  for (const { el, isNew } of finals) {
    if (isNew) {
      enterRow(el, freshTable ? Math.min(stagger++ * 22, 160) : 0);
    } else {
      const dy = firstTop.get(el.dataset.id) - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: EASE_OUT });
    }
  }
  markNew(tbody, highlight);
}

function markNew(tbody, id) {
  if (id === null || id === undefined) return;
  const row = tbody.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`);
  if (row) row.classList.add("is-new");
}

// ------------------------------------------------------------------ morph (state transitions across re-renders)

// Elements carrying data-morph="<key>" keep their visual state between renders:
// the new element briefly takes the old class/status/level/width, then switches,
// so CSS transitions run. data-count-key="<key>" data-value="<n>" counts between
// old and new numbers. data-key="<key>" elements that are new get an enter pop.

export function captureMorph(root) {
  const snap = { morph: {}, counts: {}, keys: new Set() };
  if (!root) return snap;
  root.querySelectorAll("[data-morph]").forEach((el) => {
    snap.morph[el.dataset.morph] = {
      className: el.className, status: el.dataset.status, level: el.dataset.level,
      width: el.style.width,
    };
  });
  root.querySelectorAll("[data-count-key]").forEach((el) => { snap.counts[el.dataset.countKey] = Number(el.dataset.value); });
  root.querySelectorAll("[data-key]").forEach((el) => snap.keys.add(el.dataset.key));
  snap.hadContent = root.querySelector("[data-morph], [data-key], [data-count-key]") !== null;
  return snap;
}

export function applyMorph(root, snap, { format = (n) => String(n) } = {}) {
  if (!snap || !motionOK()) return;
  const switches = [];
  root.querySelectorAll("[data-morph]").forEach((el) => {
    const prev = snap.morph[el.dataset.morph];
    el.classList.remove("intro");                      // no intro replay on re-render
    el.querySelectorAll(".intro").forEach((c) => c.classList.remove("intro"));
    if (!prev) return;
    const next = { className: el.className, status: el.dataset.status, level: el.dataset.level, width: el.style.width };
    if (prev.className === next.className && prev.status === next.status && prev.level === next.level && prev.width === next.width) return;
    el.className = prev.className.replace(/\bintro\b/, "");
    if (prev.status !== undefined) el.dataset.status = prev.status;
    if (prev.level !== undefined) el.dataset.level = prev.level;
    if (prev.width) el.style.width = prev.width;
    switches.push(() => {
      el.className = next.className;
      if (next.status !== undefined) el.dataset.status = next.status;
      if (next.level !== undefined) el.dataset.level = next.level;
      el.style.width = next.width;
      if (prev.status !== next.status && el.classList.contains("status")) {
        el.classList.remove("is-changed"); void el.offsetWidth; el.classList.add("is-changed");
      }
    });
  });
  if (switches.length) {
    void root.offsetWidth;                            // commit the "old" state
    requestAnimationFrame(() => switches.forEach((fn) => fn()));
  }
  root.querySelectorAll("[data-count-key]").forEach((el) => {
    const from = snap.counts[el.dataset.countKey];
    const to = Number(el.dataset.value);
    if (from !== undefined && from !== to) countUp(el, to, { from, format, duration: 300 });
  });
  if (snap.hadContent) {
    root.querySelectorAll("[data-key]").forEach((el) => {
      if (!snap.keys.has(el.dataset.key)) el.classList.add("enter-pop");
    });
  }
}

// ------------------------------------------------------------------ numbers

/** Animate el's text from `from` to `to`. format(n) produces the text. */
export function countUp(el, to, { from = 0, duration = 420, format = (n) => String(Math.round(n)) } = {}) {
  if (el._countRaf) cancelAnimationFrame(el._countRaf);
  if (!motionOK() || from === to || !Number.isFinite(to)) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(t === 1 ? to : from + (to - from) * eased);
    if (t < 1) el._countRaf = requestAnimationFrame(step);
  };
  el._countRaf = requestAnimationFrame(step);
}

/** Count up every [data-countup] inside root (data-value, data-format = int|money|hours). */
export function countUpAll(root, formats) {
  root.querySelectorAll("[data-countup]").forEach((el) => {
    const fmtFn = formats[el.dataset.format || "int"] || formats.int;
    countUp(el, Number(el.dataset.value), { format: fmtFn });
  });
}

// ------------------------------------------------------------------ content swaps

/**
 * Transition `el` out, run render() (sync or async), transition back in.
 * dir: 1 = moving forward (content enters from the right), -1 = back.
 * Overlapping calls on the same element: only the latest one renders.
 */
export async function swapContent(el, render, { dir = 0 } = {}) {
  const token = (el._swapToken = (el._swapToken || 0) + 1);
  if (motionOK() && el.childElementCount) {
    el.style.setProperty("--leave-x", `${dir * -10}px`);
    el.classList.remove("view-enter");
    el.classList.add("view-leave");
    await wait(120);
    if (token !== el._swapToken) return false;
  }
  el.classList.remove("view-leave");
  await render();
  if (token !== el._swapToken) return false;
  replayEnter(el, dir);
  return true;
}

export function replayEnter(el, dir = 0) {
  if (!motionOK()) return;
  el.style.setProperty("--enter-x", `${dir * 14}px`);
  el.classList.remove("view-enter");
  void el.offsetWidth;
  el.classList.add("view-enter");
}

// ------------------------------------------------------------------ skeletons

const SKEL_WIDTHS = [62, 88, 45, 74, 55, 80, 38, 68];
export const skel = (w = 70, cls = "") => `<span class="skel ${cls}" style="width:${w}%"></span>`;

export function skeletonRows(cols, rows = 6) {
  let html = "";
  for (let r = 0; r < rows; r++) {
    html += `<tr class="skeleton-row">${Array.from({ length: cols }, (_, c) =>
      `<td>${skel(SKEL_WIDTHS[(r * 3 + c) % SKEL_WIDTHS.length], c === 1 ? "skel--tall" : "")}</td>`).join("")}</tr>`;
  }
  return html;
}

export function skeletonBlock(lines = 4) {
  return `<div class="skeleton-block">${Array.from({ length: lines }, (_, i) =>
    skel(SKEL_WIDTHS[i % SKEL_WIDTHS.length])).join("")}</div>`;
}
