// Dashboard: stat cards, maintenance-spend chart, needs-attention tabs,
// status and department breakdowns.
import { api } from "../api.js";
import { countUpAll, motionOK, skel, skeletonBlock } from "../motion.js";
import { can } from "../session.js";
import { emptyState, errorState, esc, fmt, iconBadge, icons, priorityMeter, setPage, statusBadge, todayIso } from "../ui.js";

const STATUS_VARS = {
  "Pending": "--st-pending", "Assigned": "--st-assigned", "In Progress": "--st-progress",
  "On Hold": "--st-hold", "Completed": "--st-completed", "Verified": "--st-verified", "Closed": "--st-closed",
};
const OPEN_STATUSES = "Pending,Assigned,In Progress,On Hold";
const COUNT_FORMATS = { int: (n) => String(Math.round(n)), money: (n) => fmt.money(n) };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart.js paints with resolved colours, so they're re-read on every theme change.
function chartColors() {
  return {
    labour: cssVar("--ink-2"), materials: cssVar("--amber"), text: cssVar("--ink-3"),
    grid: cssVar("--line"), tooltip: cssVar("--tooltip-bg"), tooltipBorder: cssVar("--line-strong"),
  };
}

function applyChartColors(chart) {
  const c = chartColors();
  const [labour, materials] = chart.data.datasets;
  labour.backgroundColor = c.labour;
  materials.backgroundColor = c.materials;
  const { x, y } = chart.options.scales;
  x.ticks.color = c.text;
  y.ticks.color = c.text;
  y.grid.color = c.grid;
  chart.options.plugins.legend.labels.color = c.text;
  Object.assign(chart.options.plugins.tooltip, { backgroundColor: c.tooltip, borderColor: c.tooltipBorder });
}

// Remember the chosen attention tab while navigating (in memory only).
let attentionTab = null;

export default {
  reset() { attentionTab = null; },   // on sign-out
  mount(root) {
    setPage("Dashboard", ["Overview"]);
    const charts = [];
    let alive = true;

    const skelCard = () => `<div class="stat stat-card is-skeleton">
        <div class="stat-card__top">${skel(18, "skel--badge")}</div>
        <div class="label">${skel(55)}</div><div class="stat__value">${skel(35, "skel--num")}</div><div class="stat__sub">${skel(70)}</div></div>`;

    const renderShell = () => { root.innerHTML = `
      <div class="stat-cards" id="d-stats">${[1, 2, 3, 4, 5].map(skelCard).join("")}</div>

      <div class="dash-grid">
        <section class="panel">
          <div class="panel__head panel__head--tall">
            <div>
              <h2 class="panel__title">Maintenance spend</h2>
              <div class="panel__sub">Labour + materials · last 6 months</div>
            </div>
            <div class="kpi" id="d-cost-now"><span class="label">This month</span><b>${skel(60, "skel--num")}</b></div>
          </div>
          <div class="panel__body"><div class="chart-box is-loading" id="d-cost-box"><div class="chart-skeleton">${"<i></i>".repeat(6)}</div><canvas id="d-cost-chart" aria-label="Monthly maintenance cost, stacked labour and materials"></canvas></div></div>
        </section>

        <section class="panel" id="d-attention">
          <div class="panel__head">
            <h2 class="panel__title">Needs attention</h2>
            <a class="panel__link" href="#/work-orders?overdue=true">All overdue ${icons.chevronRight}</a>
          </div>
          <div class="pill-tabs" role="tablist" id="d-tabs">
            ${["Overdue", "Due soon", "Awaiting verification"].map((t) => `<span class="pill-tab is-skeleton">${esc(t)} <span class="pill-count">–</span></span>`).join("")}
          </div>
          <div id="d-attention-body" class="attention-body"><div class="panel__body">${skeletonBlock(3)}${skeletonBlock(3)}</div></div>
        </section>
      </div>

      <div class="grid-2 grid-2--even">
        <section class="panel">
          <div class="panel__head"><h2 class="panel__title">Work orders by status</h2><span class="label" id="d-scope"></span></div>
          <div class="panel__body" id="d-status-list">${skeletonBlock(6)}</div>
        </section>
        <section class="panel">
          <div class="panel__head"><h2 class="panel__title">Work orders by department</h2><span class="label">Open / total</span></div>
          <div class="panel__body" id="d-dept-list">${skeletonBlock(4)}</div>
        </section>
      </div>`; };

    renderShell();
    load();

    async function load() {
      try {
        const [summary, overdue, open, awaiting] = await Promise.all([
          api("/dashboard/summary"),
          api("/work-orders", { query: { overdue: "true", sort: "due_date", per_page: 20 } }),
          api("/work-orders", { query: { status: OPEN_STATUSES, sort: "due_date", per_page: 100 } }),
          api("/work-orders", { query: { status: "Completed", sort: "-created_at", per_page: 20 } }),
        ]);
        if (!alive) return;
        renderStats(summary);
        renderAttention({ overdue, open, awaiting });
        renderStatusList(summary);
        renderDeptList(summary);
        renderChart(summary);
      } catch (err) {
        if (!alive) return;
        root.querySelector("#d-attention-body").innerHTML = errorState("Could not load dashboard", err.message);
        root.querySelectorAll(".stat.is-skeleton .stat__value").forEach((v) => { v.textContent = "–"; });
        root.querySelectorAll(".is-skeleton, .chart-box.is-loading").forEach((s) => s.classList.remove("is-skeleton", "is-loading"));
        root.querySelectorAll("#d-status-list, #d-dept-list").forEach((p) => { p.innerHTML = '<div class="empty">Unavailable</div>'; });
        root.querySelector("#d-attention-body [data-retry]").addEventListener("click", () => {
          charts.forEach((c) => c.destroy());
          charts.length = 0;
          renderShell();
          load();
        });
      }
    }

    // ------------------------------------------------------------ stat cards

    function renderStats(s) {
      const b = s.by_status;
      const done = b["Completed"] + b["Verified"] + b["Closed"];
      const own = s.scope === "own";
      const cards = [
        { label: own ? "My work orders" : "Total work orders", value: s.total_work_orders, sub: own ? "assigned to you" : "all time", tone: "var(--steel)", icon: "layers", href: "#/work-orders" },
        { label: "Open", value: s.open_work_orders, sub: `${b["Pending"]} pending · ${b["Assigned"]} assigned`, tone: "var(--amber)", icon: "inbox", href: `#/work-orders?status=${OPEN_STATUSES}` },
        { label: "In progress", value: b["In Progress"], sub: `${b["On Hold"]} on hold`, tone: "var(--blue)", icon: "wrench", href: "#/work-orders?status=In Progress,On Hold" },
        { label: "Overdue", value: s.overdue, sub: s.overdue ? "past due date" : "none past due", tone: "var(--red)", icon: "alert", alert: s.overdue > 0, href: "#/work-orders?overdue=true" },
        { label: "Completed", value: done, sub: `${b["Completed"]} awaiting verification`, tone: "var(--green)", icon: "check", href: "#/work-orders?status=Completed,Verified,Closed" },
      ];
      const statsEl = root.querySelector("#d-stats");
      statsEl.innerHTML = cards.map((c, i) => `
        <a class="stat stat--link stat-card${c.alert ? " stat--alert" : ""} fade-up" href="${c.href}" style="--tone:${c.tone};--i:${i}">
          <div class="stat-card__top">
            ${iconBadge(c.icon, c.tone)}
            <span class="stat-card__go" aria-hidden="true">${icons.chevronRight}</span>
          </div>
          <div class="label">${esc(c.label)}</div>
          <div class="stat__value" data-countup data-value="${c.value}">0</div>
          <div class="stat__sub">${esc(c.sub)}</div>
        </a>`).join("");
      root.querySelector("#d-scope").textContent = own ? "Your work only" : "All departments";
      const costNow = root.querySelector("#d-cost-now");
      costNow.innerHTML = `<span class="label">This month</span><b data-countup data-format="money" data-value="${s.cost_this_month}">${fmt.money(0)}</b>`;
      countUpAll(statsEl, COUNT_FORMATS);
      countUpAll(costNow, COUNT_FORMATS);
    }

    // ------------------------------------------------------------ needs attention

    function renderAttention({ overdue, open, awaiting }) {
      const today = todayIso();
      const weekOut = new Date(); weekOut.setDate(weekOut.getDate() + 7);
      const weekIso = `${weekOut.getFullYear()}-${String(weekOut.getMonth() + 1).padStart(2, "0")}-${String(weekOut.getDate()).padStart(2, "0")}`;
      const dueSoon = open.work_orders.filter((w) => w.due_date && w.due_date >= today && w.due_date <= weekIso);

      const tabs = {
        overdue: {
          label: "Overdue", tone: "red", items: overdue.work_orders, total: overdue.pagination.total,
          due: (w) => { const d = fmt.daysOverdue(w.due_date); return `${d} day${d === 1 ? "" : "s"} late<br><span class="muted">due ${fmt.date(w.due_date)}</span>`; },
          empty: ["Nothing overdue", "Every open work order is within its due date.", "check"],
        },
        soon: {
          label: "Due soon", tone: "amber", items: dueSoon, total: dueSoon.length,
          due: (w) => { const d = -fmt.daysOverdue(w.due_date); return `${d === 0 ? "due today" : `due in ${d} day${d === 1 ? "" : "s"}`}<br><span class="muted">${fmt.date(w.due_date)}</span>`; },
          empty: ["Nothing due this week", "No open work orders are due in the next 7 days.", "calendar"],
        },
        verify: {
          label: "Awaiting verification", tone: "green", items: awaiting.work_orders, total: awaiting.pagination.total,
          due: (w) => `completed<br><span class="muted">${fmt.date(w.completed_at)}</span>`,
          empty: can("work_orders:verify")
            ? ["Nothing to verify", "All completed work has been signed off.", "check"]
            : ["Nothing awaiting verification", "None of your completed work is waiting on a supervisor.", "check"],
        },
      };
      if (!attentionTab || !tabs[attentionTab]) {
        attentionTab = Object.keys(tabs).find((k) => tabs[k].total > 0) || "overdue";
      }
      // Hazard stripe only while something is actually overdue.
      root.querySelector("#d-attention").classList.toggle("panel--hazard", tabs.overdue.total > 0);

      const tabsEl = root.querySelector("#d-tabs");
      tabsEl.innerHTML = Object.entries(tabs).map(([key, t]) => `
        <button class="pill-tab pill-tab--${t.tone}${key === attentionTab ? " is-active" : ""}" role="tab" type="button"
                aria-selected="${key === attentionTab}" data-tab="${key}">
          ${esc(t.label)} <span class="pill-count">${t.total}</span>
        </button>`).join("");
      tabsEl.querySelectorAll("[data-tab]").forEach((btn) => btn.addEventListener("click", () => {
        attentionTab = btn.dataset.tab;
        tabsEl.querySelectorAll("[data-tab]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        showTab();
      }));

      function showTab() {
        const t = tabs[attentionTab];
        const body = root.querySelector("#d-attention-body");
        body.dataset.tab = attentionTab;       // tints the due/completed text per tab
        body.innerHTML = t.items.length
          ? t.items.slice(0, 8).map((w, i) => attentionItem(w, t.due(w), i)).join("") +
            (t.total > 8 ? `<div class="attention-more muted mono">+ ${t.total - 8} more</div>` : "")
          : emptyState(...t.empty);
        body.querySelectorAll(".attention-item").forEach((item) => {
          const go = () => { location.hash = `#/work-orders/${item.dataset.id}`; };
          item.addEventListener("click", go);
          item.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
        });
      }
      showTab();
    }

    function attentionItem(wo, dueText, i) {
      return `<div class="attention-item fade-up" style="--i:${i}" data-id="${wo.id}" tabindex="0" role="link">
        <span class="attention-item__id">${fmt.woId(wo.id)}</span>
        <span class="attention-item__title">${esc(wo.title)}</span>
        <span class="attention-item__due">${dueText}</span>
        <div class="attention-item__meta">
          ${priorityMeter(wo.priority)} ${statusBadge(wo.status)}
          <span>${esc(wo.machine ? wo.machine.machine_code : "")}</span>
          <span>${wo.assigned_technician ? esc(wo.assigned_technician.full_name) : '<span class="chip chip--amber">Unassigned</span>'}</span>
        </div>
      </div>`;
    }

    // ------------------------------------------------------------ breakdown lists

    /** One labelled bar. value/max set the width; `strong` (optional) overlays a
     *  darker segment (e.g. open out of total). countHtml is what's shown on the right. */
    function barRow({ href, label, value, max, countHtml, tone, i, strong = null }) {
      const width = (n) => (max && n ? Math.max(3, (n / max) * 100) : 0);
      return `<a class="bar-row fade-up" href="${href}" style="--tone:${tone};--i:${i}">
        <span class="bar-row__label">${label}</span>
        <span class="bar-row__track">
          <span class="bar-row__fill${strong !== null ? " bar-row__fill--light" : ""}" style="width:${width(value)}%"></span>
          ${strong !== null ? `<span class="bar-row__fill" style="width:${width(strong)}%"></span>` : ""}
        </span>
        <span class="bar-row__count">${countHtml}</span>
      </a>`;
    }

    function renderStatusList(s) {
      const statuses = Object.keys(STATUS_VARS);   // workflow order
      const max = Math.max(1, ...statuses.map((x) => s.by_status[x]));
      const el = root.querySelector("#d-status-list");
      el.innerHTML = s.total_work_orders
        ? `<div class="bar-list">${statuses.map((x, i) => barRow({
            href: `#/work-orders?status=${encodeURIComponent(x)}`,
            label: statusBadge(x), value: s.by_status[x], max, countHtml: String(s.by_status[x]),
            tone: `var(${STATUS_VARS[x]})`, i,
          })).join("")}</div>
          <div class="bar-list__foot mono">${s.total_work_orders} TOTAL · ${s.open_work_orders} OPEN</div>`
        : emptyState("No work orders yet", "Status breakdown appears once work orders exist.", "chart");
    }

    function renderDeptList(s) {
      const depts = s.by_department || [];
      const el = root.querySelector("#d-dept-list");
      if (!depts.length) {
        el.innerHTML = emptyState("No department data yet", "Counts appear here as work orders are raised against departments.", "chart");
        return;
      }
      const max = Math.max(1, ...depts.map((d) => d.total));
      const tones = ["var(--steel)", "var(--amber)", "var(--teal)", "var(--rust)", "var(--blue)", "var(--green)"];
      el.innerHTML = `<div class="bar-list">${depts.map((d, i) => barRow({
          href: `#/work-orders?department=${encodeURIComponent(d.department)}`,
          label: `<span class="bar-row__name">${iconBadge("building", tones[i % tones.length], "xs")}${esc(d.department)}</span>`,
          value: d.total, max, strong: d.open,
          countHtml: `<b>${d.open}</b><span class="muted"> / ${d.total}</span>`,
          tone: tones[i % tones.length], i,
        })).join("")}</div>
        <div class="bar-list__foot"><span class="legend-swatch"></span> open <span class="legend-swatch legend-swatch--light"></span> total</div>`;
    }

    // ------------------------------------------------------------ chart

    function renderChart(s) {
      const box = root.querySelector("#d-cost-box");
      box.classList.remove("is-loading");
      if (!window.Chart) {
        box.innerHTML = emptyState("Chart unavailable", "Chart.js could not be loaded from the CDN.", "chart");
        return;
      }
      const Chart = window.Chart;
      Chart.defaults.font.family = cssVar("--font-body") || "Barlow, sans-serif";
      const c = chartColors();
      const mono = { family: "IBM Plex Mono, monospace", size: 11 };

      // Stacked bars grow in on load, staggered left-to-right. Reduced motion: none.
      const animation = motionOK()
        ? {
            duration: 300,
            easing: "easeOutQuart",
            delay: (ctx) => (ctx.type === "data" && ctx.mode === "default" ? ctx.dataIndex * 45 + ctx.datasetIndex * 60 : 0),
          }
        : false;

      charts.push(new Chart(root.querySelector("#d-cost-chart"), {
        type: "bar",
        data: {
          labels: s.cost_by_month.map((m) => m.label.toUpperCase()),
          datasets: [
            { label: "Labour", data: s.cost_by_month.map((m) => m.labour_cost), backgroundColor: c.labour, stack: "c", borderRadius: 4, borderSkipped: false, maxBarThickness: 44 },
            { label: "Materials", data: s.cost_by_month.map((m) => m.material_cost), backgroundColor: c.materials, stack: "c", borderRadius: 4, borderSkipped: false, maxBarThickness: 44 },
          ],
        },
        options: {
          animation,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "top", align: "end", labels: { color: c.text, usePointStyle: true, pointStyle: "rectRounded", boxWidth: 10, boxHeight: 10, font: { family: "Barlow Condensed", size: 13, weight: 600 } } },
            tooltip: {
              backgroundColor: c.tooltip, borderColor: c.tooltipBorder, borderWidth: 1, padding: 10, cornerRadius: 8,
              titleFont: { family: "Barlow Condensed", size: 13, weight: 600 }, bodyFont: mono, footerFont: { ...mono, weight: 600 },
              callbacks: {
                label: (ctx) => ` ${ctx.dataset.label}: ${fmt.money(ctx.parsed.y)}`,
                footer: (items) => `Total: ${fmt.money(items.reduce((a, i) => a + i.parsed.y, 0))}`,
              },
            },
          },
          scales: {
            x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { color: c.text, font: { family: "Barlow Condensed", size: 12, weight: 600 } } },
            y: { stacked: true, beginAtZero: true, grid: { color: c.grid, drawTicks: false }, border: { display: false }, ticks: { color: c.text, font: mono, padding: 8 } },
          },
        },
      }));
    }

    // update("none") skips shared element options (bar colours), so do a full
    // update with animation briefly disabled - the page cross-fade covers it.
    const onTheme = () => charts.forEach((chart) => {
      applyChartColors(chart);
      const animation = chart.options.animation;
      chart.options.animation = false;
      chart.update();
      chart.options.animation = animation;
    });
    window.addEventListener("themechange", onTheme);

    return {
      destroy() {
        alive = false;
        window.removeEventListener("themechange", onTheme);
        charts.forEach((c) => c.destroy());
      },
    };
  },
};
