// Activity Log (Admin only): who did what, when. Filterable, grouped by day,
// loads more as you scroll.
import { api } from "../api.js";
import { skeletonBlock } from "../motion.js";
import { debounce, emptyState, errorState, esc, fmt, icons, initials, option, setPage } from "../ui.js";

const CATEGORY_LABELS = {
  work_order: "Work orders", material: "Materials", labour: "Labour",
  machine: "Machines", maintenance: "Maintenance notes", user: "Users",
};
const CATEGORY_TONES = {
  work_order: "var(--steel)", material: "var(--amber-deep)", labour: "var(--blue)",
  machine: "var(--teal)", maintenance: "var(--green)", user: "var(--red)",
};
const EMPTY = { q: "", actor_id: "", action: "", date_from: "", date_to: "" };
const filters = { ...EMPTY };

export default {
  reset() { Object.assign(filters, EMPTY); },   // on sign-out

  mount(root) {
    setPage("Activity Log", ["Administration"]);
    let alive = true;
    let first = true;         // next load replaces the list
    let lastId = null;        // cursor: load entries older than this
    let hasMore = false;
    let total = 0;
    let loading = false;
    let seq = 0;
    let lastDay = null;
    let observer = null;

    root.innerHTML = `
      <div class="toolbar">
        <div class="search">${icons.search}<input id="a-q" type="search" placeholder="Search activity (e.g. WO-00019, tech2, retired)…" aria-label="Search activity"></div>
        <div class="field"><label for="a-actor">User</label><select id="a-actor">${option("", "Anyone")}</select></div>
        <div class="field"><label for="a-action">Action</label><select id="a-action">${option("", "All actions")}</select></div>
        <div class="field"><label for="a-from">From</label><input id="a-from" type="date"></div>
        <div class="field"><label for="a-to">To</label><input id="a-to" type="date"></div>
        <button class="btn btn--ghost btn--sm" id="a-clear" type="button">Clear</button>
      </div>
      <section class="panel">
        <div class="panel__head"><h2 class="panel__title">Activity</h2><span class="label" id="a-count"></span></div>
        <div class="activity" id="a-list"><div class="panel__body">${skeletonBlock(5)}${skeletonBlock(5)}</div></div>
        <div class="activity__more" id="a-more"></div>
      </section>`;

    const $ = (s) => root.querySelector(s);
    const inputs = { q: $("#a-q"), actor_id: $("#a-actor"), action: $("#a-action"), date_from: $("#a-from"), date_to: $("#a-to") };
    for (const [key, el] of Object.entries(inputs)) el.value = filters[key];

    const reload = () => { first = true; lastId = null; load(); };
    inputs.q.addEventListener("input", debounce(() => { filters.q = inputs.q.value.trim(); reload(); }, 280));
    for (const key of ["actor_id", "action", "date_from", "date_to"]) {
      inputs[key].addEventListener("change", () => { filters[key] = inputs[key].value; reload(); });
    }
    $("#a-clear").addEventListener("click", () => {
      Object.assign(filters, EMPTY);
      for (const [key, el] of Object.entries(inputs)) el.value = filters[key];
      reload();
    });
    $("#a-list").addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-toggle-details]");
      if (toggle) {
        const item = toggle.closest(".activity-item");
        item.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", String(item.classList.contains("is-open")));
      }
      if (e.target.closest("[data-retry]")) reload();
    });

    loadFilters();
    load();

    async function loadFilters() {
      try {
        const f = await api("/audit-log/filters");
        if (!alive) return;
        inputs.actor_id.innerHTML = option("", "Anyone") +
          f.actors.map((a) => option(a.id, `${a.name} (${a.role})`, String(a.id) === filters.actor_id)).join("");
        const groups = f.categories.map((cat) => `<optgroup label="${esc(CATEGORY_LABELS[cat] || cat)}">
            ${option(`category:${cat}`, `All ${(CATEGORY_LABELS[cat] || cat).toLowerCase()}`, filters.action === `category:${cat}`)}
            ${f.actions.filter((a) => a.category === cat).map((a) => option(a.key, a.label, a.key === filters.action)).join("")}
          </optgroup>`).join("");
        inputs.action.innerHTML = option("", "All actions") + groups;
      } catch { /* the list shows the error */ }
    }

    async function load() {
      const mine = ++seq;
      loading = true;
      const replacing = first;
      if (replacing) $("#a-list").classList.add("is-loading");
      const query = { q: filters.q, actor_id: filters.actor_id, date_from: filters.date_from, date_to: filters.date_to,
                      per_page: 50, before_id: replacing ? "" : lastId };
      if (filters.action.startsWith("category:")) query.category = filters.action.slice(9);
      else query.action = filters.action;
      try {
        const data = await api("/audit-log", { query });
        if (mine !== seq || !alive) return;
        if (replacing) total = data.pagination.total;
        hasMore = data.pagination.total > data.entries.length;
        if (data.entries.length) lastId = data.entries[data.entries.length - 1].id;
        first = false;
        render(data.entries, replacing);
      } catch (err) {
        const first = replacing;
        if (mine !== seq || !alive) return;
        if (first) $("#a-list").innerHTML = errorState(
          err.status === 503 ? "Activity log not set up" : "Could not load activity", err.message);
        else toast_(err.message);
        $("#a-more").innerHTML = "";
      } finally {
        if (mine === seq) { loading = false; $("#a-list").classList.remove("is-loading"); }
      }
    }

    function toast_(msg) {
      $("#a-more").innerHTML = `<span class="muted">${esc(msg)}</span> <button class="btn btn--sm" data-more>Retry</button>`;
      $("#a-more [data-more]").addEventListener("click", () => load());
    }

    function render(entries, first) {
      const list = $("#a-list");
      if (first) { list.innerHTML = ""; lastDay = null; }
      if (first && !entries.length) {
        const filtered = Object.values(filters).some(Boolean);
        list.innerHTML = emptyState(filtered ? "No matching activity" : "No activity yet",
          filtered ? "Try widening the date range or clearing filters." : "Actions such as status changes and user edits will appear here.", "search");
      }
      let html = "";
      entries.forEach((e, i) => {
        const day = (e.created_at || "").slice(0, 10);
        if (day !== lastDay) {
          html += `<div class="activity-day">${esc(dayLabel(day))}</div>`;
          lastDay = day;
        }
        html += item(e, i);
      });
      list.insertAdjacentHTML("beforeend", html);

      const shown = list.querySelectorAll(".activity-item").length;
      $("#a-count").textContent = total ? `${shown} of ${total}` : "";
      $("#a-more").innerHTML = hasMore
        ? `<button class="btn btn--sm" data-more>Load older</button>` : (shown ? `<span class="muted mono">END OF LOG</span>` : "");
      const more = $("#a-more [data-more]");
      if (more) {
        more.addEventListener("click", next);
        // Infinite scroll: load the next page when the button scrolls into view.
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((obs) => { if (obs[0].isIntersecting) next(); }, { rootMargin: "200px" });
        observer.observe(more);
      }
    }

    function next() {
      if (loading || !hasMore) return;
      load();
    }

    function item(e, i) {
      const cat = e.action.split(".")[0];
      const time = (e.created_at || "").slice(11, 19);
      const link = entityLink(e);
      return `<article class="activity-item fade-up" style="--i:${Math.min(i, 12)}">
        <div class="activity-item__time mono">${esc(time)}</div>
        <span class="avatar avatar--sm avatar--${esc((e.actor.role || "").toLowerCase())}" aria-hidden="true">${esc(initials(e.actor.name))}</span>
        <div class="activity-item__body">
          <div class="activity-item__summary">${esc(e.summary)}</div>
          <div class="activity-item__meta">
            <span class="activity-chip" style="--tone:${CATEGORY_TONES[cat] || "var(--grey)"}">${esc(actionLabel(e.action))}</span>
            ${link}
            <span class="role-tag role-tag--${esc((e.actor.role || "").toLowerCase())}">${esc(e.actor.role)}</span>
            ${hasDetails(e) ? `<button class="activity-item__toggle" type="button" data-toggle-details aria-expanded="false">Details ${icons.chevronDown}</button>` : ""}
          </div>
          ${hasDetails(e) ? `<div class="activity-item__details">${details(e)}</div>` : ""}
        </div>
      </article>`;
    }

    function entityLink(e) {
      const label = esc(e.entity_label || "");
      const woId = e.entity_type === "work_order" ? e.entity_id : e.details && e.details.work_order_id;
      if (woId && e.action !== "work_order.deleted") return `<a class="mono" href="#/work-orders/${woId}">${label || fmt.woId(woId)}</a>`;
      if (e.entity_type === "machine" && e.entity_id) return `<a class="mono" href="#/machines/${e.entity_id}">${label}</a>`;
      if (e.entity_type === "user") return `<a class="mono" href="#/users">${label}</a>`;
      return label ? `<span class="mono muted">${label}</span>` : "";
    }

    return {
      destroy() { alive = false; if (observer) observer.disconnect(); },
    };
  },
};

const ACTION_LABELS = {
  "work_order.created": "Created", "work_order.updated": "Edited", "work_order.status_changed": "Status",
  "work_order.deleted": "Deleted", "material.added": "Material added", "material.updated": "Material edited",
  "material.deleted": "Material removed", "labour.logged": "Labour", "machine.created": "Machine added",
  "machine.updated": "Machine edited", "machine.retired": "Retired", "machine.reactivated": "Reactivated",
  "maintenance.note_added": "Note", "user.created": "User created", "user.updated": "User edited",
  "user.deactivated": "Deactivated", "user.reactivated": "Reactivated", "user.password_reset": "Password reset",
  "user.password_changed": "Password changed", "work_order.rated": "Rated",
  "material.photo_added": "Photo added", "material.photo_removed": "Photo removed", "material.photo_reviewed": "Photo reviewed",
};
const actionLabel = (a) => ACTION_LABELS[a] || a;

function dayLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  const long = d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  return diff === 0 ? `TODAY · ${long}` : diff === 1 ? `YESTERDAY · ${long}` : long;
}

const HIDDEN_DETAIL_KEYS = new Set(["from", "to", "work_order_id", "history_id"]);

function hasDetails(e) {
  return e.details && Object.keys(e.details).some((k) => !HIDDEN_DETAIL_KEYS.has(k) && e.details[k] !== null && e.details[k] !== "");
}

function short(value) {
  if (value === null || value === undefined || value === "") return "—";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

function details(e) {
  const rows = [];
  for (const [key, value] of Object.entries(e.details)) {
    if (HIDDEN_DETAIL_KEYS.has(key) || value === null || value === "") continue;
    if (key === "changes") {
      for (const [field, ch] of Object.entries(value)) {
        rows.push(`<div><span class="k">${esc(field)}</span><span class="v"><s>${esc(short(ch.from))}</s> → <b>${esc(short(ch.to))}</b></span></div>`);
      }
    } else {
      rows.push(`<div><span class="k">${esc(key.replaceAll("_", " "))}</span><span class="v">${esc(short(value))}</span></div>`);
    }
  }
  return rows.join("");
}
