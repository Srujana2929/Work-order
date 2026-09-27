// Work orders: live-filtered table, detail modal (status workflow, progress,
// materials, labour), create/edit form. Technicians only ever receive their
// own work orders from the API, so the same view serves every role.
import { api } from "../api.js";
import { applyMorph, captureMorph, collapseRow, motionOK, renderRows, skeletonBlock, skeletonRows, wait } from "../motion.js";
import { can, isTechnician } from "../session.js";
import {
  check, clearErrors, collect, confirmDialog, debounce, emptyRow, errorRow, errorState, esc, field, fmt,
  formValues, icons, openModal, option, priorityMeter, progressBar,
  setPage, showErrors, showServerError, statusBadge, toast, todayIso, withBusy,
} from "../ui.js";

const STATUSES = ["Pending", "Assigned", "In Progress", "On Hold", "Completed", "Verified", "Closed"];
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const CATEGORIES = ["Preventive", "Corrective", "Breakdown", "Inspection", "Calibration", "Installation", "Other"];
// Mirrors backend/workflow.py
const LOCKED = ["Verified", "Closed"];
const PROGRESS_STATUSES = ["Assigned", "In Progress", "On Hold"];
const REASSIGN_STATUSES = ["Pending", "Assigned", "In Progress", "On Hold"];
const COST_STATUSES = ["Assigned", "In Progress", "On Hold", "Completed"];
const PIPELINE = ["Pending", "Assigned", "In Progress", "Completed", "Verified", "Closed"];

const EMPTY_FILTERS = { q: "", status: "", priority: "", assignee: "", department: "", overdue: false };

// Filters survive navigating away and back (in memory only).
const state = { filters: { ...EMPTY_FILTERS }, page: 1, perPage: 20, sort: "-created_at" };

export default {
  reset() { Object.assign(state, { filters: { ...EMPTY_FILTERS }, page: 1, sort: "-created_at" }); },   // on sign-out
  mount(root, params, query) {
    setPage("Work Orders", ["Operations"]);
    const tech = isTechnician();
    let lookups = { machines: [], technicians: [], departments: [] };
    let listSeq = 0;
    let detail = null;         // { id, modal }
    let alive = true;

    applyQuery(query);

    root.innerHTML = `
      <div class="toolbar">
        <div class="search">${icons.search}<input id="wo-q" type="search" placeholder="Search title or description…" aria-label="Search"></div>
        <div class="field"><label for="wo-status">Status</label><select id="wo-status"></select></div>
        <div class="field"><label for="wo-priority">Priority</label><select id="wo-priority"></select></div>
        ${tech ? "" : `<div class="field"><label for="wo-assignee">Assignee</label><select id="wo-assignee"></select></div>`}
        <div class="field"><label for="wo-dept">Department</label><select id="wo-dept"></select></div>
        <label class="field field--inline" style="min-height:38px"><input type="checkbox" id="wo-overdue"> <span class="field__label">Overdue</span></label>
        <button class="btn btn--ghost btn--sm" id="wo-clear" type="button">Clear</button>
        <div class="spacer"></div>
        ${can("work_orders:create") ? `<button class="btn btn--accent" id="wo-new" type="button">${icons.plus} New work order</button>` : ""}
      </div>
      ${tech ? `<div class="notice" style="margin-bottom:14px">Showing work orders assigned to you.</div>` : ""}
      <section class="panel">
        <div class="table-wrap">
          <table class="data" id="wo-table">
            <thead><tr>
              <th class="sortable" data-sort="id">ID</th>
              <th>Work order</th>
              <th class="sortable" data-sort="priority">Priority</th>
              <th class="sortable" data-sort="status">Status</th>
              <th>Progress</th>
              <th>Assignee</th>
              <th>Dept.</th>
              <th class="sortable" data-sort="due_date">Due</th>
              <th class="sortable num" data-sort="total_cost">Total cost</th>
            </tr></thead>
            <tbody>${skeletonRows(9, 6)}</tbody>
          </table>
        </div>
        <div class="table-foot"><span id="wo-count"></span><div class="pager" id="wo-pager"></div></div>
      </section>`;

    const $ = (sel) => root.querySelector(sel);
    const table = $("#wo-table");

    // ---- filters
    fillFilterSelects();
    $("#wo-q").value = state.filters.q;
    $("#wo-overdue").checked = state.filters.overdue;
    const reload = () => { state.page = 1; loadList(); };
    $("#wo-q").addEventListener("input", debounce((e) => { state.filters.q = e.target.value.trim(); reload(); }, 280));
    for (const [id, key] of [["#wo-status", "status"], ["#wo-priority", "priority"], ["#wo-assignee", "assignee"], ["#wo-dept", "department"]]) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", () => { state.filters[key] = sel.value; reload(); });
    }
    $("#wo-overdue").addEventListener("change", (e) => { state.filters.overdue = e.target.checked; reload(); });
    $("#wo-clear").addEventListener("click", () => {
      state.filters = { ...EMPTY_FILTERS };
      $("#wo-q").value = ""; $("#wo-overdue").checked = false;
      fillFilterSelects();
      if (location.hash.includes("?")) history.replaceState(null, "", "#/work-orders");
      reload();
    });
    if ($("#wo-new")) $("#wo-new").addEventListener("click", () => openForm(null));

    table.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = state.sort === `-${key}` ? key : `-${key}`;
      loadList();
    }));
    table.querySelector("tbody").addEventListener("click", (e) => {
      if (e.target.closest("[data-retry]")) { loadList(); return; }
      const tr = e.target.closest("tr[data-id]");
      if (tr) location.hash = `#/work-orders/${tr.dataset.id}`;
    });

    const lookupsReady = loadLookups().then(() => { if (alive) fillFilterSelects(); });
    loadList();
    if (params[0]) openDetail(Number(params[0]));

    // ------------------------------------------------------------ list

    function applyQuery(q) {
      if (!q || !Object.keys(q).length) return;
      state.filters = {
        ...EMPTY_FILTERS,
        status: q.status || "", priority: q.priority || "", assignee: q.assignee || "",
        department: q.department || "", q: q.q || "", overdue: q.overdue === "true",
      };
      state.page = 1;
    }

    function fillFilterSelects() {
      const f = state.filters;
      // Multi-value filters from dashboard links (e.g. "Completed,Verified,Closed") get their own option.
      const withCustom = (list, value) => (value && !list.includes(value) ? [...list, value] : list);
      $("#wo-status").innerHTML = option("", "All statuses") +
        withCustom(STATUSES, f.status).map((s) => option(s, s.replaceAll(",", " / "), s === f.status)).join("");
      $("#wo-priority").innerHTML = option("", "All priorities") +
        withCustom(PRIORITIES, f.priority).map((p) => option(p, p.replaceAll(",", " / "), p === f.priority)).join("");
      if ($("#wo-assignee")) {
        $("#wo-assignee").innerHTML = option("", "Anyone") + option("unassigned", "Unassigned", f.assignee === "unassigned") +
          lookups.technicians.map((t) => option(t.id, t.full_name, String(t.id) === f.assignee)).join("");
      }
      $("#wo-dept").innerHTML = option("", "All departments") +
        withCustom(lookups.departments, f.department).map((d) => option(d, d, d === f.department)).join("");
    }

    async function loadLookups() {
      try {
        const [machines, techs] = await Promise.all([
          api("/machines", { query: { per_page: 100 } }),
          can("users:list_technicians")
            ? api("/users", { query: { role: "Technician", is_active: "true" } })
            : Promise.resolve({ users: [] }),
        ]);
        lookups = {
          machines: machines.machines,
          technicians: techs.users,
          departments: [...new Set(machines.machines.map((m) => m.department))].sort(),
        };
      } catch (err) {
        toast(`Could not load machines/technicians: ${err.message}`, "error");
      }
      return lookups;
    }

    /** Reload the table. highlight: id of a just-created work order to mark. */
    async function loadList({ highlight = null } = {}) {
      const seq = ++listSeq;
      table.classList.add("is-loading");
      const f = state.filters;
      try {
        const data = await api("/work-orders", { query: {
          q: f.q, status: f.status, priority: f.priority, assignee: f.assignee,
          department: f.department, overdue: f.overdue ? "true" : "",
          sort: state.sort, page: state.page, per_page: state.perPage,
        } });
        if (seq !== listSeq || !alive) return;
        renderTable(data, highlight);
      } catch (err) {
        if (seq !== listSeq || !alive) return;
        renderRows(table.querySelector("tbody"), errorRow(9, "Could not load work orders", err.message));
      } finally {
        if (seq === listSeq) table.classList.remove("is-loading");
      }
    }

    function renderTable({ work_orders: rows, pagination: p }, highlight) {
      table.querySelectorAll("th.sortable").forEach((th) => {
        const key = th.dataset.sort;
        const ind = state.sort === key ? "▲" : state.sort === `-${key}` ? "▼" : "";
        th.innerHTML = th.innerHTML.replace(/<span class="sort-ind">.*?<\/span>/, "") + (ind ? `<span class="sort-ind">${ind}</span>` : "");
      });

      const filtered = Object.values(state.filters).some(Boolean);
      renderRows(table.querySelector("tbody"), rows.length ? rows.map((wo) => `
        <tr class="clickable${wo.priority === "Critical" && !["Completed", "Verified", "Closed"].includes(wo.status) ? " is-critical" : ""}" data-id="${wo.id}">
          <td class="mono nowrap">${fmt.woId(wo.id)}</td>
          <td><div class="cell-title">${esc(wo.title)}</div>
              <div class="cell-sub"><span class="mono">${esc(wo.machine.machine_code)}</span> · ${esc(wo.machine.name)} · ${esc(wo.category)}</div></td>
          <td>${priorityMeter(wo.priority, "prio")}</td>
          <td>${statusBadge(wo.status, "status")}</td>
          <td>${progressBar(wo.progress, "progress")}</td>
          <td class="nowrap">${wo.assigned_technician ? esc(wo.assigned_technician.full_name) : '<span class="chip chip--amber">Unassigned</span>'}</td>
          <td>${esc(wo.department)}</td>
          <td class="mono nowrap${wo.is_overdue ? " overdue" : ""}">${fmt.date(wo.due_date)}${wo.is_overdue ? " ▲" : ""}</td>
          <td class="num">${fmt.money(wo.total_cost)}</td>
        </tr>`).join("")
        : emptyRow(9, filtered ? "No matching work orders" : "No work orders yet",
            filtered ? "Try clearing some filters." : (can("work_orders:create") ? "Create the first one with “New work order”." : "")),
        { highlight });

      const from = p.total ? (p.page - 1) * p.per_page + 1 : 0;
      const to = Math.min(p.page * p.per_page, p.total);
      $("#wo-count").textContent = `${from}–${to} OF ${p.total} WORK ORDERS`;
      $("#wo-pager").innerHTML = p.pages > 1 ? `
        <button class="btn btn--sm" data-page="${p.page - 1}" ${p.page <= 1 ? "disabled" : ""}>Prev</button>
        <span>PAGE ${p.page}/${p.pages}</span>
        <button class="btn btn--sm" data-page="${p.page + 1}" ${p.page >= p.pages ? "disabled" : ""}>Next</button>` : "";
      $("#wo-pager").querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
        state.page = Number(b.dataset.page); loadList();
      }));
    }

    // ------------------------------------------------------------ detail modal

    async function openDetail(id) {
      if (detail && detail.id === id && !detail.modal.isClosed) return;
      if (detail) detail.modal.close();
      const modal = openModal({
        wide: true, eyebrow: fmt.woId(id), title: "Loading…", body: detailSkeleton(), foot: "",
        onClose: () => {
          if (detail && detail.modal === modal) detail = null;
          if (/^#\/work-orders\/\d+/.test(location.hash)) history.replaceState(null, "", "#/work-orders");
        },
      });
      detail = { id, modal };

      const fetchDetail = async () => {
        try {
          // Technician list is needed for the "assign" control.
          const [{ work_order }] = await Promise.all([api(`/work-orders/${id}`), lookupsReady]);
          if (!modal.isClosed) renderDetail(work_order, { initial: true });
        } catch (err) {
          if (modal.isClosed) return;
          const notFound = err.status === 404;
          modal.setTitle(notFound ? "Not found" : "Could not load");
          modal.setBody(notFound
            ? errorState("Work order not found", isTechnician() ? "It may not exist, or it isn't assigned to you." : err.message, { retry: false })
            : errorState("Could not load work order", err.message), { animate: true });
          modal.setFoot(`<button class="btn" data-close>Close</button>`);
          const retry = modal.body.querySelector("[data-retry]");
          if (retry) retry.addEventListener("click", () => {
            modal.setTitle("Loading…");
            modal.setBody(detailSkeleton());
            fetchDetail();
          });
        }
      };
      await fetchDetail();
    }

    /** Re-fetch and re-render the open detail. submittedForm: the form that
     *  triggered it (its fields are cleared); other forms keep what was typed. */
    async function refreshDetail(submittedForm = null) {
      if (!detail) return;
      detail.skipDraft = submittedForm;
      try {
        const { work_order } = await api(`/work-orders/${detail.id}`);
        if (detail && !detail.modal.isClosed) renderDetail(work_order);
      } catch (err) { toast(err.message, "error"); }
    }

    /** Render the detail modal. On refreshes, state changes (status lamp, priority
     *  bars, workflow steps, progress, costs) animate from their previous values. */
    function renderDetail(wo, { initial = false } = {}) {
      const modal = detail.modal;
      const snap = initial ? null : captureMorph(modal.body);
      const drafts = initial ? null : captureDrafts(modal.body, detail.skipDraft);
      detail.skipDraft = null;
      const locked = LOCKED.includes(wo.status);
      const canEdit = can("work_orders:edit") && !locked;
      const canProgress = (can("work_orders:update_work") || can("work_orders:edit")) && PROGRESS_STATUSES.includes(wo.status);
      const canCosts = can("work_orders:log_costs") && COST_STATUSES.includes(wo.status);
      const person = (p) => (p ? esc(p.full_name) : '<span class="muted">—</span>');

      modal.setEyebrow(`${fmt.woId(wo.id)} · ${wo.category.toUpperCase()}`);
      modal.setTitle(wo.title);
      modal.setBody(`
        ${workflowStrip(wo.status)}
        <div class="row" style="margin:16px 0 18px">
          ${statusBadge(wo.status, "status")} ${priorityMeter(wo.priority, "prio")}
          ${wo.is_overdue ? `<span class="chip chip--red">Overdue ${fmt.daysOverdue(wo.due_date)}d</span>` : ""}
        </div>
        <div class="detail-grid">
          <div>
            <div class="facts">
              ${fact("Machine", `<span class="mono">${esc(wo.machine.machine_code)}</span> ${esc(wo.machine.name)}`)}
              ${fact("Department", esc(wo.department))}
              ${fact("Assigned to", wo.assigned_technician ? person(wo.assigned_technician) : '<span class="chip chip--amber">Unassigned</span>')}
              ${fact("Created by", person(wo.created_by))}
              ${fact("Created", `<span class="mono">${fmt.dateTime(wo.created_at)}</span>`)}
              ${fact("Due date", `<span class="mono${wo.is_overdue ? " overdue" : ""}" style="${wo.is_overdue ? "color:var(--red)" : ""}">${fmt.date(wo.due_date)}</span>`)}
              ${fact("Started", `<span class="mono">${fmt.dateTime(wo.started_at)}</span>`)}
              ${fact("Completed", `<span class="mono">${fmt.dateTime(wo.completed_at)}</span>`)}
              ${fact("Verified", wo.verified_at ? `<span class="mono">${fmt.dateTime(wo.verified_at)}</span><br><span class="muted">${person(wo.verified_by)}</span>` : '<span class="mono">—</span>')}
              ${fact("Closed", `<span class="mono">${fmt.dateTime(wo.closed_at)}</span>`)}
            </div>

            <div class="section-title">Description</div>
            <div class="desc">${wo.description ? esc(wo.description) : '<span class="muted">No description.</span>'}</div>

            <div class="section-title">Progress</div>
            ${canProgress ? `
              <form id="d-progress" class="row" novalidate>
                <input type="range" name="progress" min="0" max="100" step="5" value="${wo.progress}" style="flex:1;min-width:160px" aria-label="Progress">
                <output class="mono" style="width:44px;text-align:right">${wo.progress}%</output>
                <button class="btn btn--sm" type="submit">Save progress</button>
              </form>` : progressBar(wo.progress, "progress")}

            <div class="section-title">Materials used <span class="label">${wo.materials.length} item${wo.materials.length === 1 ? "" : "s"}</span></div>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Material</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Line total</th><th>Logged by</th>${canCosts ? "<th></th>" : ""}</tr></thead>
              <tbody id="d-materials">${wo.materials.length ? wo.materials.map((m) => `
                <tr data-key="mat-${m.id}" data-material="${m.id}"><td><div class="cell-title">${esc(m.material_name)}</div>${m.part_number ? `<div class="cell-sub mono">${esc(m.part_number)}</div>` : ""}</td>
                    <td class="num nowrap">${fmt.num(m.quantity)} ${esc(m.unit)}</td>
                    <td class="num">${fmt.money(m.unit_cost)}</td>
                    <td class="num" data-count-key="line-${m.id}" data-value="${m.line_total}">${fmt.money(m.line_total)}</td>
                    <td class="nowrap">${m.added_by ? esc(m.added_by.full_name) : "—"}<div class="cell-sub mono">${fmt.dateTime(m.created_at)}</div></td>
                    ${canCosts ? `<td class="row-actions">
                      <button class="icon-btn icon-btn--sm" type="button" data-mat-act="edit" title="Edit material" aria-label="Edit ${esc(m.material_name)}">${icons.edit}</button>
                      <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-mat-act="delete" title="Remove material" aria-label="Remove ${esc(m.material_name)}">${icons.trash}</button>
                    </td>` : ""}</tr>`).join("")
                : emptyRow(canCosts ? 6 : 5, "No materials logged")}</tbody>
            </table></div>
          </div>

          <aside>
            ${statusBox(wo)}
            <div class="side-box">
              <div class="side-box__head">Cost</div>
              <div class="side-box__body">
                <table class="cost-table">
                  <tr><td>Labour <span class="muted mono">${fmt.num(wo.labour_hours)} h × ${fmt.money(wo.labour_rate)}</span></td><td data-count-key="labour" data-value="${wo.labour_cost}">${fmt.money(wo.labour_cost)}</td></tr>
                  <tr><td>Materials</td><td data-count-key="materials" data-value="${wo.material_cost}">${fmt.money(wo.material_cost)}</td></tr>
                  <tr class="total"><td>Total cost</td><td data-count-key="total" data-value="${wo.total_cost}">${fmt.money(wo.total_cost)}</td></tr>
                </table>
              </div>
            </div>
            ${canCosts ? labourBox(wo) + materialBox() : ""}
          </aside>
        </div>`, { animate: initial });
      if (snap) applyMorph(modal.body, snap, { format: fmt.money });
      if (drafts) restoreDrafts(modal.body, drafts);

      modal.setFoot(`
        ${can("work_orders:delete") ? `<button class="btn btn--danger left" data-act="delete">Delete</button>` : ""}
        <button class="btn" data-close>Close</button>
        ${canEdit ? `<button class="btn btn--primary" data-act="edit">Edit details</button>` : ""}`);

      wireDetail(wo);
    }

    // Half-typed values in the labour/material forms survive a re-render caused
    // by another action (e.g. saving progress while typing a material).
    const DRAFT_FORMS = ["d-labour", "d-material"];

    function captureDrafts(body, skipFormId) {
      const drafts = {};
      for (const id of DRAFT_FORMS) {
        const form = body.querySelector(`#${id}`);
        if (!form || id === skipFormId) continue;
        drafts[id] = {};
        for (const el of form.elements) {
          if (el.name && !el.readOnly && el.value !== el.defaultValue) drafts[id][el.name] = el.value;
        }
      }
      return drafts;
    }

    function restoreDrafts(body, drafts) {
      for (const [id, values] of Object.entries(drafts)) {
        const form = body.querySelector(`#${id}`);
        if (!form) continue;       // e.g. costs are locked after this change
        for (const [name, value] of Object.entries(values)) {
          if (form.elements[name] && !form.elements[name].readOnly) form.elements[name].value = value;
        }
      }
    }

    function detailSkeleton() {
      return `<div class="steps steps--skeleton">${"<i></i>".repeat(6)}</div>
        <div class="detail-grid" style="margin-top:22px">
          <div>${skeletonBlock(5)}${skeletonBlock(3)}</div>
          <div>${skeletonBlock(4)}</div>
        </div>`;
    }

    function fact(label, valueHtml) {
      return `<div class="fact"><div class="label">${esc(label)}</div><div class="fact__value">${valueHtml}</div></div>`;
    }

    function workflowStrip(status) {
      const onHold = status === "On Hold";
      const currentIdx = PIPELINE.indexOf(onHold ? "In Progress" : status);
      return `<ol class="steps">${PIPELINE.map((s, i) => {
        const cls = i < currentIdx ? "is-done" : i === currentIdx ? (onHold ? "is-hold" : "is-current") : "";
        return `<li class="${cls}" data-morph="step-${i}"><span>${esc(i === currentIdx && onHold ? "On Hold" : s)}</span></li>`;
      }).join("")}</ol>`;
    }

    function statusBox(wo) {
      const next = wo.allowed_transitions;
      let body;
      if (next.length) {
        body = `<form id="d-status" novalidate>
          <div class="form__error" role="alert"></div>
          ${field({ name: "status", label: "Move to", options: next.map((s) => option(s, s)).join("") })}
          <div data-extra="assign" hidden>
            ${field({ name: "assigned_technician_id", label: "Technician", required: true,
                      options: option("", "Select technician…") + lookups.technicians.map((t) => option(t.id, t.full_name, wo.assigned_technician && wo.assigned_technician.id === t.id)).join("") })}
          </div>
          <div data-extra="notes" hidden>
            ${field({ name: "work_performed", label: "Work performed", type: "textarea", hint: "Saved to the machine's maintenance history.", attrs: 'rows="3" maxlength="5000"' })}
            ${field({ name: "downtime_hours", label: "Machine downtime (hours)", type: "number", attrs: 'min="0" step="0.25" inputmode="decimal"' })}
            ${field({ name: "remarks", label: "Remarks", type: "textarea", attrs: 'rows="2" maxlength="5000"' })}
          </div>
          <div class="notice notice--amber" data-extra="rework" hidden style="margin-bottom:12px">Sends the work back to the technician and removes its maintenance-history entry until it's completed again.</div>
          <button class="btn btn--primary btn--block" type="submit">Update status</button>
        </form>`;
      } else {
        body = `<div class="notice">${esc(noTransitionReason(wo))}</div>`;
      }
      return `<div class="side-box"><div class="side-box__head">Status ${statusBadge(wo.status, "status-side")}</div><div class="side-box__body">${body}</div></div>`;
    }

    function noTransitionReason(wo) {
      if (wo.status === "Closed") return "This work order is closed. No further changes are possible.";
      if (wo.status === "Verified") return "Verified. Waiting for a supervisor to close it.";
      if (wo.status === "Completed") return "Completed. Waiting for a supervisor to verify the work.";
      if (wo.status === "Pending") return "Waiting for a supervisor to assign a technician.";
      if (!isTechnician()) return `Only the assigned technician can move this work order out of “${wo.status}”.`;
      return "No status changes are available.";
    }

    function labourBox(wo) {
      const rateFixed = wo.labour_hours > 0;
      return `<div class="side-box"><div class="side-box__head">Log labour</div><div class="side-box__body">
        <form id="d-labour" novalidate>
          <div class="form__error" role="alert"></div>
          <div class="form-grid">
            ${field({ name: "hours", label: "Hours", type: "number", required: true, attrs: 'min="0.25" max="1000" step="0.25" inputmode="decimal"' })}
            ${field({ name: "hourly_rate", label: "Rate / hour", type: "number", value: wo.labour_rate > 0 ? wo.labour_rate.toFixed(2) : "",
                      required: wo.labour_rate === 0, attrs: `min="0" step="0.01" inputmode="decimal"${rateFixed ? " readonly" : ""}`,
                      hint: rateFixed ? "Fixed once hours are logged." : "" })}
          </div>
          <button class="btn btn--block" type="submit">Add labour</button>
        </form></div></div>`;
    }

    function materialBox() {
      return `<div class="side-box"><div class="side-box__head">Add material</div><div class="side-box__body">
        <form id="d-material" novalidate>
          <div class="form__error" role="alert"></div>
          ${field({ name: "material_name", label: "Material", required: true, attrs: 'maxlength="120" list="d-material-names"' })}
          <div class="form-grid">
            ${field({ name: "quantity", label: "Quantity", type: "number", required: true, attrs: 'min="0.01" step="0.01" inputmode="decimal"' })}
            ${field({ name: "unit", label: "Unit", value: "pcs", attrs: 'maxlength="20" list="d-units"' })}
            ${field({ name: "unit_cost", label: "Unit cost", type: "number", required: true, attrs: 'min="0" step="0.01" inputmode="decimal"' })}
            ${field({ name: "part_number", label: "Part no.", attrs: 'maxlength="60"' })}
          </div>
          <datalist id="d-units"><option value="pcs"><option value="kg"><option value="L"><option value="m"><option value="set"><option value="box"></datalist>
          <button class="btn btn--block" type="submit">Add material</button>
        </form></div></div>`;
    }

    function wireDetail(wo) {
      const body = detail.modal.body;
      const foot = detail.modal.foot;
      const after = async (message, formId) => { toast(message); await refreshDetail(formId); loadList(); };

      // Status
      const statusForm = body.querySelector("#d-status");
      if (statusForm) {
        const sync = () => {
          const to = statusForm.elements.status.value;
          statusForm.querySelector('[data-extra="assign"]').hidden = !(to === "Assigned" && !wo.assigned_technician);
          statusForm.querySelector('[data-extra="notes"]').hidden = !["Completed", "Verified"].includes(to);
          statusForm.querySelector('[data-extra="rework"]').hidden = !(wo.status === "Completed" && to === "In Progress");
        };
        statusForm.elements.status.addEventListener("change", sync);
        sync();
        statusForm.addEventListener("submit", (e) => {
          e.preventDefault();
          clearErrors(statusForm);
          const v = formValues(statusForm);
          const payload = { status: v.status };
          const needsTech = v.status === "Assigned" && !wo.assigned_technician;
          const notes = ["Completed", "Verified"].includes(v.status);
          const errors = collect({
            assigned_technician_id: [needsTech ? check.required(v.assigned_technician_id, "Technician") : ""],
            downtime_hours: [notes ? check.decimal(v.downtime_hours, { min: 0, max: 999999 }) : ""],
          });
          if (!showErrors(statusForm, errors)) return;
          if (needsTech) payload.assigned_technician_id = Number(v.assigned_technician_id);
          if (notes) {
            if (v.work_performed) payload.work_performed = v.work_performed;
            if (v.downtime_hours !== "") payload.downtime_hours = Number(v.downtime_hours);
            if (v.remarks) payload.remarks = v.remarks;
          }
          withBusy(statusForm.querySelector("[type=submit]"), async () => {
            try {
              await api(`/work-orders/${wo.id}/status`, { method: "PATCH", body: payload });
              await after(`${fmt.woId(wo.id)} → ${v.status}`, "d-status");
            } catch (err) { showServerError(statusForm, err); }
          });
        });
      }

      // Progress
      const progressForm = body.querySelector("#d-progress");
      if (progressForm) {
        const range = progressForm.elements.progress;
        range.addEventListener("input", () => { progressForm.querySelector("output").textContent = `${range.value}%`; });
        progressForm.addEventListener("submit", (e) => {
          e.preventDefault();
          withBusy(progressForm.querySelector("[type=submit]"), async () => {
            try {
              await api(`/work-orders/${wo.id}`, { method: "PUT", body: { progress: Number(range.value) } });
              await after(`Progress saved: ${range.value}%`, "d-progress");
            } catch (err) { toast(err.message, "error"); }
          });
        });
      }

      // Labour
      const labourForm = body.querySelector("#d-labour");
      if (labourForm) {
        labourForm.addEventListener("submit", (e) => {
          e.preventDefault();
          clearErrors(labourForm);
          const v = formValues(labourForm);
          const errors = collect({
            hours: [check.required(v.hours, "Hours"), check.decimal(v.hours, { positive: true, max: 1000 })],
            hourly_rate: [wo.labour_rate === 0 ? check.required(v.hourly_rate, "Rate") : "", check.decimal(v.hourly_rate, { min: 0 })],
          });
          if (!showErrors(labourForm, errors)) return;
          const payload = { hours: Number(v.hours) };
          if (v.hourly_rate !== "" && wo.labour_hours === 0) payload.hourly_rate = Number(v.hourly_rate);
          withBusy(labourForm.querySelector("[type=submit]"), async () => {
            try {
              await api(`/work-orders/${wo.id}/labour-cost`, { method: "POST", body: payload });
              await after(`Logged ${v.hours} h labour`, "d-labour");
            } catch (err) { showServerError(labourForm, err); }
          });
        });
      }

      // Materials
      const materialForm = body.querySelector("#d-material");
      if (materialForm) {
        materialForm.addEventListener("submit", (e) => {
          e.preventDefault();
          clearErrors(materialForm);
          const v = formValues(materialForm);
          const errors = collect({
            material_name: [check.required(v.material_name, "Material"), check.maxLen(v.material_name, 120)],
            quantity: [check.required(v.quantity, "Quantity"), check.decimal(v.quantity, { positive: true })],
            unit_cost: [check.required(v.unit_cost, "Unit cost"), check.decimal(v.unit_cost, { min: 0 })],
          });
          if (!showErrors(materialForm, errors)) return;
          const payload = { material_name: v.material_name, quantity: Number(v.quantity), unit_cost: Number(v.unit_cost), unit: v.unit || "pcs" };
          if (v.part_number) payload.part_number = v.part_number;
          withBusy(materialForm.querySelector("[type=submit]"), async () => {
            try {
              await api(`/work-orders/${wo.id}/materials`, { method: "POST", body: payload });
              await after(`Added ${v.quantity} ${payload.unit} ${v.material_name}`, "d-material");
            } catch (err) { showServerError(materialForm, err); }
          });
        });
      }

      // Material edit / delete
      const materialsBody = body.querySelector("#d-materials");
      if (materialsBody) materialsBody.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-mat-act]");
        if (!btn) return;
        const tr = btn.closest("tr[data-material]");
        const material = wo.materials.find((m) => String(m.id) === tr.dataset.material);
        if (!material) return;
        if (btn.dataset.matAct === "edit") { openMaterialForm(wo, material, after); return; }

        const ok = await confirmDialog({
          title: `Remove ${material.material_name}?`, danger: true, confirmLabel: "Remove material",
          message: `${fmt.num(material.quantity)} ${material.unit} × ${fmt.money(material.unit_cost)} = ${fmt.money(material.line_total)} will be taken off ${fmt.woId(wo.id)}'s material cost.`,
        });
        if (!ok) return;
        await withBusy(btn, async () => {
          try {
            await api(`/work-orders/${wo.id}/materials/${material.id}`, { method: "DELETE" });
            await collapseRow(tr);
            await after(`Removed ${material.material_name}`, "d-material");
          } catch (err) { toast(err.message, "error"); }
        });
      });

      // Footer actions
      const editBtn = foot.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener("click", () => openForm(wo));
      const delBtn = foot.querySelector('[data-act="delete"]');
      if (delBtn) delBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: `Delete ${fmt.woId(wo.id)}?`, danger: true, confirmLabel: "Delete work order",
          message: `“${wo.title}” and its ${wo.materials.length} material record(s) will be permanently deleted. Maintenance history already recorded for the machine is kept.`,
        });
        if (!ok) return;
        try {
          await api(`/work-orders/${wo.id}`, { method: "DELETE" });
          toast(`${fmt.woId(wo.id)} deleted`);
          if (detail) detail.modal.close();
          loadList();
        } catch (err) { toast(err.message, "error"); }
      });
    }

    // ------------------------------------------------------------ material edit form

    function openMaterialForm(wo, material, after) {
      const modal = openModal({
        title: "Edit material", eyebrow: `${fmt.woId(wo.id)} · logged ${fmt.dateTime(material.created_at)}`,
        body: `<form class="form" novalidate>
          <div class="form__error" role="alert"></div>
          ${field({ name: "material_name", label: "Material", required: true, value: material.material_name, attrs: 'maxlength="120" autofocus' })}
          <div class="form-grid">
            ${field({ name: "quantity", label: "Quantity", type: "number", required: true, value: material.quantity, attrs: 'min="0.01" step="0.01" inputmode="decimal"' })}
            ${field({ name: "unit", label: "Unit", value: material.unit, attrs: 'maxlength="20"' })}
            ${field({ name: "unit_cost", label: "Unit cost", type: "number", required: true, value: material.unit_cost.toFixed(2), attrs: 'min="0" step="0.01" inputmode="decimal"' })}
            ${field({ name: "part_number", label: "Part no.", value: material.part_number || "", attrs: 'maxlength="60"' })}
          </div>
          <div class="notice" id="m-line-preview"></div>
        </form>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-save>Save material</button>`,
      });
      const form = modal.body.querySelector("form");
      const preview = () => {
        const q = Number(form.elements.quantity.value), c = Number(form.elements.unit_cost.value);
        form.querySelector("#m-line-preview").textContent = Number.isFinite(q * c)
          ? `Line total: ${fmt.money(Math.round(q * c * 100) / 100)} (was ${fmt.money(material.line_total)})` : "";
      };
      form.addEventListener("input", preview);
      preview();

      const save = () => {
        clearErrors(form);
        const v = formValues(form);
        const errors = collect({
          material_name: [check.required(v.material_name, "Material"), check.maxLen(v.material_name, 120)],
          quantity: [check.required(v.quantity, "Quantity"), check.decimal(v.quantity, { positive: true })],
          unit_cost: [check.required(v.unit_cost, "Unit cost"), check.decimal(v.unit_cost, { min: 0 })],
        });
        if (!showErrors(form, errors)) return;
        const next = { material_name: v.material_name, quantity: Number(v.quantity), unit: v.unit || "pcs",
                       unit_cost: Number(v.unit_cost), part_number: v.part_number || null };
        const body = Object.fromEntries(Object.entries(next).filter(([k, val]) => val !== (material[k] ?? null)));
        if (!Object.keys(body).length) { modal.close(); toast("No changes to save", "warn"); return; }
        withBusy(modal.foot.querySelector("[data-save]"), async () => {
          try {
            await api(`/work-orders/${wo.id}/materials/${material.id}`, { method: "PUT", body });
            modal.close();
            await after(`${next.material_name} updated`, "d-material-edit");
          } catch (err) { showServerError(form, err); }
        });
      };
      modal.foot.querySelector("[data-save]").addEventListener("click", save);
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    }

    // ------------------------------------------------------------ create / edit form

    async function openForm(wo) {
      await lookupsReady;
      // The machine list may have failed to load earlier (network blip): retry once.
      if (!lookups.machines.length) {
        await loadLookups();
        if (alive) fillFilterSelects();
      }
      if (!lookups.machines.length) {
        toast(can("machines:manage")
          ? "No machines are available. Register a machine first (Machines page), then create the work order."
          : "No machines are available to raise a work order against.", "error");
        return;
      }
      const editing = Boolean(wo);
      const machines = lookups.machines.filter((m) => m.status !== "Retired" || (wo && wo.machine.id === m.id));
      const canReassign = !editing || REASSIGN_STATUSES.includes(wo.status);
      const canUnassign = !editing || ["Pending", "Assigned"].includes(wo.status);
      const minDue = editing ? wo.created_at.slice(0, 10) : todayIso();

      const techOptions = (canUnassign ? option("", "— Unassigned —") : "") +
        lookups.technicians.map((t) => option(t.id, t.full_name, wo && wo.assigned_technician && wo.assigned_technician.id === t.id)).join("") +
        // keep a no-longer-listed (e.g. deactivated) current technician visible
        (wo && wo.assigned_technician && !lookups.technicians.some((t) => t.id === wo.assigned_technician.id)
          ? option(wo.assigned_technician.id, `${wo.assigned_technician.full_name} (inactive)`, true) : "");

      const modal = openModal({
        title: editing ? "Edit work order" : "New work order",
        eyebrow: editing ? fmt.woId(wo.id) : "Raise a work order",
        body: `<form class="form" novalidate>
          <div class="form__error" role="alert"></div>
          <div class="form-grid">
            ${field({ name: "title", label: "Title", required: true, value: wo ? wo.title : "", span: true, attrs: 'maxlength="150" autofocus' })}
            ${field({ name: "description", label: "Description", type: "textarea", value: wo ? wo.description || "" : "", span: true, attrs: 'rows="3"' })}
            ${field({ name: "machine_id", label: "Machine / equipment", required: true,
                      options: option("", "Select machine…") + machines.map((m) => option(m.id, `${m.machine_code} — ${m.name}`, wo && wo.machine.id === m.id)).join("") })}
            ${field({ name: "department", label: "Department", required: true, value: wo ? wo.department : "", attrs: 'maxlength="100" list="wo-dept-list"', hint: editing ? "" : "Defaults to the machine's department." })}
            ${field({ name: "category", label: "Category", options: CATEGORIES.map((c) => option(c, c, wo ? wo.category === c : c === "Corrective")).join("") })}
            ${field({ name: "priority", label: "Priority", options: PRIORITIES.map((p) => option(p, p, wo ? wo.priority === p : p === "Medium")).join("") })}
            ${field({ name: "due_date", label: "Due date", type: "date", value: wo ? wo.due_date || "" : "", attrs: `min="${minDue}"` })}
            ${field({ name: "assigned_technician_id", label: "Technician", options: techOptions,
                      attrs: canReassign ? "" : "disabled",
                      hint: !canReassign ? `Can't reassign a ${wo.status.toLowerCase()} work order.` : (!editing ? "Assigning moves it straight to Assigned." : (!canUnassign ? "Work has started; pick another technician to reassign." : "")) })}
            ${field({ name: "labour_rate", label: "Labour rate / hour", type: "number", value: wo && wo.labour_rate ? wo.labour_rate.toFixed(2) : "", attrs: 'min="0" step="0.01" inputmode="decimal"' })}
            ${editing ? field({ name: "labour_hours", label: "Labour hours (correction)", type: "number", value: wo.labour_hours.toFixed(2), attrs: 'min="0" step="0.25" inputmode="decimal"', hint: "Normally logged from the work order." }) : ""}
          </div>
          <datalist id="wo-dept-list">${lookups.departments.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
        </form>`,
        foot: `<button class="btn" data-close>Cancel</button>
               <button class="btn btn--primary" data-save>${editing ? "Save changes" : "Create work order"}</button>`,
      });

      const form = modal.body.querySelector("form");
      // Default the department from the selected machine (until the user types one).
      let deptTouched = editing;
      form.elements.department.addEventListener("input", () => { deptTouched = true; });
      form.elements.machine_id.addEventListener("change", () => {
        const m = lookups.machines.find((x) => String(x.id) === form.elements.machine_id.value);
        if (m && !deptTouched) form.elements.department.value = m.department;
      });

      const save = () => {
        clearErrors(form);
        const v = formValues(form);
        const errors = collect({
          title: [check.required(v.title, "Title"), check.maxLen(v.title, 150)],
          machine_id: [check.required(v.machine_id, "Machine")],
          department: [check.required(v.department, "Department"), check.maxLen(v.department, 100)],
          due_date: [v.due_date && v.due_date < minDue ? `Due date can't be before ${minDue}` : ""],
          labour_rate: [check.decimal(v.labour_rate, { min: 0 })],
          labour_hours: [editing ? check.decimal(v.labour_hours, { min: 0 }) : ""],
        });
        if (!showErrors(form, errors)) return;

        const payload = {
          title: v.title,
          description: v.description || null,
          machine_id: Number(v.machine_id),
          department: v.department,
          category: v.category,
          priority: v.priority,
          due_date: v.due_date || null,
        };
        if (canReassign) payload.assigned_technician_id = v.assigned_technician_id ? Number(v.assigned_technician_id) : null;
        if (v.labour_rate !== "") payload.labour_rate = Number(v.labour_rate);
        if (editing && v.labour_hours !== "") payload.labour_hours = Number(v.labour_hours);

        let body = payload;
        if (editing) {
          // Send only what changed - some fields are status-restricted server-side.
          const original = {
            title: wo.title, description: wo.description || null, machine_id: wo.machine.id,
            department: wo.department, category: wo.category, priority: wo.priority,
            due_date: wo.due_date || null, assigned_technician_id: wo.assigned_technician ? wo.assigned_technician.id : null,
            labour_rate: wo.labour_rate, labour_hours: wo.labour_hours,
          };
          body = Object.fromEntries(Object.entries(payload).filter(([k, val]) => val !== original[k]));
          if (!Object.keys(body).length) { modal.close(); toast("No changes to save", "warn"); return; }
        } else if (payload.assigned_technician_id === null) {
          delete payload.assigned_technician_id;
        }
        if (!editing && payload.description === null) delete payload.description;
        if (!editing && payload.due_date === null) delete payload.due_date;

        withBusy(modal.foot.querySelector("[data-save]"), async () => {
          try {
            const res = await api(editing ? `/work-orders/${wo.id}` : "/work-orders",
                                  { method: editing ? "PUT" : "POST", body });
            modal.close();
            if (editing) {
              toast(`${fmt.woId(wo.id)} updated`);
              await refreshDetail();
              loadList();
            } else {
              const newId = res.work_order.id;
              toast(`${fmt.woId(newId)} created`);
              // Let the new row slide into the table before its detail opens.
              await loadList({ highlight: newId });
              if (motionOK()) await wait(380);
              if (alive) location.hash = `#/work-orders/${newId}`;
            }
          } catch (err) { showServerError(form, err); }
        });
      };
      modal.foot.querySelector("[data-save]").addEventListener("click", save);
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    }

    return {
      update(newParams, newQuery) {
        if (newQuery && Object.keys(newQuery).length) {
          applyQuery(newQuery);
          $("#wo-q").value = state.filters.q;
          $("#wo-overdue").checked = state.filters.overdue;
          fillFilterSelects();
          loadList();
        }
        if (newParams[0]) openDetail(Number(newParams[0]));
        else if (detail) detail.modal.close();
      },
      destroy() {
        alive = false;
        if (detail) detail.modal.close();
      },
    };
  },
};
