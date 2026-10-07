// Machines: registry list (#/machines) and machine detail with its
// maintenance history (#/machines/<id>).
import { api } from "../api.js";
import { applyMorph, captureMorph, countUpAll, renderRows, skel, skeletonBlock, skeletonRows, swapContent } from "../motion.js";
import { can } from "../session.js";
import {
  check, clearErrors, collect, debounce, emptyRow, emptyState, errorRow, errorState, esc, field, fmt, formValues, iconBadge, icons,
  openModal, option, setPage, showErrors, showServerError, statusBadge,
  toast, todayIso, withBusy,
} from "../ui.js";

const COUNT_FORMATS = {
  int: (n) => String(Math.round(n)),
  money: (n) => fmt.money(n),
  hours: (n) => `${fmt.num(Math.round(n * 100) / 100)} h`,
};

const MACHINE_STATUSES = ["Operational", "Under Maintenance", "Breakdown", "Retired"];
const ACTIVE_STATUSES = MACHINE_STATUSES.filter((s) => s !== "Retired");   // "Retired" only via Retire
const CATEGORIES = ["Preventive", "Corrective", "Breakdown", "Inspection", "Calibration", "Installation", "Other"];
const listState = { q: "", department: "", status: "", page: 1 };
const STATUS_TONES = { Operational: "var(--green)", "Under Maintenance": "var(--amber)", Breakdown: "var(--red)", Retired: "var(--grey)" };

export default {
  reset() { Object.assign(listState, { q: "", department: "", status: "", page: 1 }); },   // on sign-out
  mount(root, params) {
    let alive = true;
    let departments = [];
    render(params);

    function render(p) {
      if (p[0]) renderDetail(Number(p[0]));
      else renderList();
    }

    // ================================================================ list

    function renderList() {
      setPage("Machines", ["Assets"]);
      root.innerHTML = `
        <div class="toolbar">
          <div class="search">${icons.search}<input id="m-q" type="search" placeholder="Search code, name, location, serial…" aria-label="Search machines"></div>
          <div class="field"><label for="m-dept">Department</label><select id="m-dept"><option value="">All departments</option></select></div>
          <div class="field"><label for="m-status">Status</label><select id="m-status">${option("", "All statuses")}${MACHINE_STATUSES.map((s) => option(s, s, s === listState.status)).join("")}</select></div>
          <div class="spacer"></div>
          ${can("machines:manage") ? `<button class="btn btn--accent" id="m-new">${icons.plus} Register machine</button>` : ""}
        </div>
        <section class="panel">
          <div class="table-wrap"><table class="data" id="m-table">
            <thead><tr><th>Code</th><th>Machine</th><th>Department</th><th>Location</th><th>Installed</th><th>Status</th><th class="num">Open WOs</th></tr></thead>
            <tbody>${skeletonRows(7, 5)}</tbody>
          </table></div>
          <div class="table-foot"><span id="m-count"></span><div class="pager" id="m-pager"></div></div>
        </section>`;

      const $ = (s) => root.querySelector(s);
      $("#m-q").value = listState.q;
      $("#m-q").addEventListener("input", debounce((e) => { listState.q = e.target.value.trim(); listState.page = 1; load(); }, 280));
      $("#m-dept").addEventListener("change", (e) => { listState.department = e.target.value; listState.page = 1; load(); });
      $("#m-status").addEventListener("change", (e) => { listState.status = e.target.value; listState.page = 1; load(); });
      if ($("#m-new")) $("#m-new").addEventListener("click", () => openMachineForm(null));
      $("#m-table tbody").addEventListener("click", (e) => {
        if (e.target.closest("[data-retry]")) { load(); return; }
        const emptyAct = e.target.closest("[data-empty]");
        if (emptyAct) {
          if (emptyAct.dataset.empty === "new") { openMachineForm(null); return; }
          Object.assign(listState, { q: "", department: "", status: "", page: 1 });
          $("#m-q").value = ""; $("#m-dept").value = ""; $("#m-status").value = "";
          load();
          return;
        }
        const tr = e.target.closest("tr[data-id]");
        if (tr) location.hash = `#/machines/${tr.dataset.id}`;
      });

      // Department options come from the full registry.
      api("/machines", { query: { per_page: 100 } }).then(({ machines }) => {
        if (!alive || !$("#m-dept")) return;
        departments = [...new Set(machines.map((m) => m.department))].sort();
        $("#m-dept").innerHTML = option("", "All departments") + departments.map((d) => option(d, d, d === listState.department)).join("");
      }).catch(() => {});

      let seq = 0;
      async function load() {
        const mine = ++seq;
        $("#m-table").classList.add("is-loading");
        try {
          const data = await api("/machines", { query: { q: listState.q, department: listState.department, status: listState.status, page: listState.page, per_page: 25 } });
          if (mine !== seq || !alive || !$("#m-table")) return;
          const tbody = $("#m-table tbody");
          renderRows(tbody, data.machines.length ? data.machines.map((m) => `
            <tr class="clickable${m.status === "Retired" ? " is-inactive" : ""}" data-id="${m.id}">
              <td class="nowrap"><span class="code-chip code-chip--lg">${esc(m.machine_code)}</span></td>
              <td><div class="person">${iconBadge("machine", STATUS_TONES[m.status] || "var(--steel)", "sm")}
                <div><div class="cell-title">${esc(m.name)}</div><div class="cell-sub">${esc([m.manufacturer, m.model].filter(Boolean).join(" · ")) || "&nbsp;"}</div></div></div></td>
              <td><span class="with-icon">${icons.building}${esc(m.department)}</span></td>
              <td>${m.location ? esc(m.location) : '<span class="muted">—</span>'}</td>
              <td class="mono">${fmt.date(m.install_date)}</td>
              <td>${statusBadge(m.status)}</td>
              <td class="num">${m.open_work_orders ? `<span class="chip chip--amber">${m.open_work_orders}</span>` : '<span class="muted">0</span>'}</td>
            </tr>`).join("")
            : (listState.q || listState.department || listState.status)
              ? emptyRow(7, "No machines found", "Nothing matches these filters.", "search",
                  `<button class="btn btn--sm" type="button" data-empty="clear">Clear filters</button>`)
              : emptyRow(7, "No machines registered yet",
                  can("machines:manage") ? "Register your equipment so work orders and maintenance history can be tracked against it." : "Machines appear here once a supervisor registers them.",
                  "machine", can("machines:manage") ? `<button class="btn btn--accent btn--sm" type="button" data-empty="new">${icons.plus} Register machine</button>` : ""));
          const p = data.pagination;
          $("#m-count").textContent = `${p.total} MACHINE${p.total === 1 ? "" : "S"}`;
          $("#m-pager").innerHTML = p.pages > 1 ? `
            <button class="btn btn--sm" data-page="${p.page - 1}" ${p.page <= 1 ? "disabled" : ""}>Prev</button>
            <span>PAGE ${p.page}/${p.pages}</span>
            <button class="btn btn--sm" data-page="${p.page + 1}" ${p.page >= p.pages ? "disabled" : ""}>Next</button>` : "";
          $("#m-pager").querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => { listState.page = Number(b.dataset.page); load(); }));
        } catch (err) {
          if (mine === seq && alive && $("#m-table")) renderRows($("#m-table tbody"), errorRow(7, "Could not load machines", err.message));
        } finally {
          if (mine === seq && $("#m-table")) $("#m-table").classList.remove("is-loading");
        }
      }
      load();
    }

    // ================================================================ register / edit / retire

    /** Register (machine = null) or edit a machine. Edits send only changed fields. */
    function openMachineForm(machine) {
      const editing = Boolean(machine);
      const retired = editing && machine.status === "Retired";
      const statusOptions = retired
        ? option("Retired", "Retired", true)
        : ACTIVE_STATUSES.map((s) => option(s, s, s === (editing ? machine.status : "Operational"))).join("");
      const val = (k) => (editing && machine[k] ? machine[k] : "");
      const modal = openModal({
        title: editing ? "Edit machine" : "Register machine",
        eyebrow: editing ? `${machine.machine_code} · ${machine.name}` : "Asset registry",
        body: `<form class="form" novalidate>
          <div class="form__error" role="alert"></div>
          <div class="form-grid">
            ${field({ name: "machine_code", label: "Asset code", required: true, value: val("machine_code"), hint: "e.g. CNC-002. Letters, digits, - _ .", attrs: 'maxlength="30" autofocus style="text-transform:uppercase" class="mono"' })}
            ${field({ name: "name", label: "Name", required: true, value: val("name"), attrs: 'maxlength="120"' })}
            ${field({ name: "department", label: "Department", required: true, value: val("department"), attrs: 'maxlength="100" list="m-dept-list"' })}
            ${field({ name: "install_date", label: "Install date", type: "date", value: val("install_date"), attrs: `max="${todayIso()}"` })}
            ${field({ name: "location", label: "Location", value: val("location"), attrs: 'maxlength="120"' })}
            ${field({ name: "status", label: "Status", options: statusOptions, attrs: retired ? "disabled" : "",
                      hint: retired ? "Reactivate the machine to change its status." : "To retire a machine, use Retire on its page." })}
            ${field({ name: "manufacturer", label: "Manufacturer", value: val("manufacturer"), attrs: 'maxlength="100"' })}
            ${field({ name: "model", label: "Model", value: val("model"), attrs: 'maxlength="100"' })}
            ${field({ name: "serial_number", label: "Serial number", span: true, value: val("serial_number"), attrs: 'maxlength="100"' })}
          </div>
          <datalist id="m-dept-list">${departments.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
        </form>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-save>${editing ? "Save changes" : "Register"}</button>`,
      });
      const form = modal.body.querySelector("form");
      const save = () => {
        clearErrors(form);
        const v = formValues(form);
        const errors = collect({
          machine_code: [check.required(v.machine_code, "Asset code"), v.machine_code && !/^[A-Za-z0-9_.-]{1,30}$/.test(v.machine_code) ? "Only letters, digits, '-', '_' and '.'" : ""],
          name: [check.required(v.name, "Name")],
          department: [check.required(v.department, "Department")],
          install_date: [v.install_date && v.install_date > todayIso() ? "Install date can't be in the future" : ""],
        });
        if (!showErrors(form, errors)) return;
        v.machine_code = v.machine_code.toUpperCase();

        let body;
        if (editing) {
          // Only what changed; "" clears an optional field.
          body = Object.fromEntries(Object.entries(v)
            .filter(([k, value]) => value !== (machine[k] ?? ""))
            .map(([k, value]) => [k, value === "" ? null : value]));
          if (!Object.keys(body).length) { modal.close(); toast("No changes to save", "warn"); return; }
        } else {
          body = Object.fromEntries(Object.entries(v).filter(([, value]) => value !== ""));
        }
        withBusy(modal.foot.querySelector("[data-save]"), async () => {
          try {
            const res = await api(editing ? `/machines/${machine.id}` : "/machines", { method: editing ? "PUT" : "POST", body });
            modal.close();
            if (editing) {
              toast(`${res.machine.machine_code} updated`);
              renderDetail(machine.id, { morph: true });
            } else {
              toast(`${res.machine.machine_code} registered`);
              location.hash = `#/machines/${res.machine.id}`;
            }
          } catch (err) { showServerError(form, err); }
        });
      };
      modal.foot.querySelector("[data-save]").addEventListener("click", save);
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    }

    /** Retire (with optional reason) or reactivate. */
    function openRetire(machine) {
      const retiring = machine.status !== "Retired";
      const modal = openModal({
        title: retiring ? `Retire ${machine.machine_code}?` : `Reactivate ${machine.machine_code}?`,
        eyebrow: machine.name, danger: retiring,
        body: `<form class="form" novalidate>
          <div class="form__error" role="alert"></div>
          <p style="margin-top:0">${retiring
            ? "The machine will be hidden from new work orders. Its maintenance history and past work orders are kept, and you can reactivate it at any time."
            : "The machine goes back to <b>Operational</b> and can be used for new work orders again."}</p>
          ${field({ name: "reason", label: retiring ? "Reason (optional)" : "Note (optional)", type: "textarea", attrs: 'rows="2" maxlength="200" autofocus',
                    hint: "Recorded in the activity log." })}
        </form>`,
        foot: `<button class="btn" data-close>Cancel</button>
               <button class="btn ${retiring ? "btn--danger" : "btn--primary"}" data-save>${retiring ? "Retire machine" : "Reactivate"}</button>`,
      });
      const form = modal.body.querySelector("form");
      const save = () => {
        clearErrors(form);
        const v = formValues(form);
        withBusy(modal.foot.querySelector("[data-save]"), async () => {
          try {
            await api(`/machines/${machine.id}/retire`, { method: "PATCH", body: { retired: retiring, reason: v.reason || null } });
            modal.close();
            toast(retiring ? `${machine.machine_code} retired` : `${machine.machine_code} reactivated`);
            renderDetail(machine.id, { morph: true });
          } catch (err) { showServerError(form, err); }
        });
      };
      modal.foot.querySelector("[data-save]").addEventListener("click", save);
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    }

    // ================================================================ detail + history

    /** morph: re-render in place, animating changed state (e.g. the status lamp). */
    async function renderDetail(id, { highlightEntry = null, morph = false } = {}) {
      setPage("Machine", [["Machines", "#/machines"], "Detail"]);
      if (!root.querySelector(".machine-head")) {
        root.innerHTML = `
          <div class="machine-head">${skel(8, "skel--tag")}${skel(28, "skel--title")}</div>
          <div class="stat-cards">${[1, 2, 3, 4, 5].map(() => `<div class="stat stat-card is-skeleton"><div class="stat-card__top">${skel(18, "skel--badge")}</div><div class="label">${skel(50)}</div><div class="stat__value">${skel(40, "skel--num")}</div><div class="stat__sub">${skel(60)}</div></div>`).join("")}</div>
          <div class="grid-2 grid-2--side"><div class="panel panel__body">${skeletonBlock(5)}</div><div class="panel panel__body">${skeletonBlock(6)}</div></div>`;
      }
      let machine;
      try {
        ({ machine } = await api(`/machines/${id}`));
      } catch (err) {
        if (!alive) return;
        const notFound = err.status === 404;
        root.innerHTML = `<a class="btn btn--ghost btn--sm" href="#/machines" style="margin:-6px 0 12px -10px">${icons.back} All machines</a>
          <div class="panel">${errorState(notFound ? "Machine not found" : "Could not load machine", err.message, { retry: !notFound })}</div>`;
        const retry = root.querySelector("[data-retry]");
        if (retry) retry.addEventListener("click", () => { root.innerHTML = ""; renderDetail(id, { highlightEntry }); });
        return;
      }
      if (!alive) return;
      setPage(machine.name, [["Machines", "#/machines"], machine.machine_code]);
      const s = machine.stats;
      const retired = machine.status === "Retired";
      const snap = morph ? captureMorph(root) : null;

      root.innerHTML = `
        <a class="btn btn--ghost btn--sm" href="#/machines" style="margin:-6px 0 12px -10px">${icons.back} All machines</a>
        <div class="machine-head">
          <span class="machine-head__code">${esc(machine.machine_code)}</span>
          <span class="machine-head__name">${esc(machine.name)}</span>
          ${statusBadge(machine.status, "machine-status")}
          ${can("machines:manage") ? `<div class="machine-head__actions">
            <button class="btn btn--sm" type="button" id="m-edit">${icons.edit} Edit</button>
            <button class="btn btn--sm ${retired ? "" : "btn--danger"}" type="button" id="m-retire">${retired ? `${icons.restore} Reactivate` : `${icons.archive} Retire`}</button>
          </div>` : ""}
        </div>
        ${retired ? `<div class="notice notice--amber retired-banner fade-up">${icons.archive}<span><b>Retired.</b> Hidden from new work orders. History and past work orders are kept.</span></div>` : ""}
        <div class="stat-cards" id="m-stats">
          ${stat("Work orders", s.total_work_orders, "all time", "var(--steel)", false, "int", "layers")}
          ${stat("Open", s.open_work_orders, "not yet completed", "var(--amber)", s.open_work_orders > 0, "int", "inbox")}
          ${stat("Maintenance cost", s.total_maintenance_cost, "from history", "var(--blue)", false, "money", "coins")}
          ${stat("Downtime", s.total_downtime_hours, "recorded", "var(--red)", false, "hours", "clock")}
          ${stat("Last maintenance", s.last_maintenance_date ? fmt.date(s.last_maintenance_date) : "—", `${s.history_entries} history entr${s.history_entries === 1 ? "y" : "ies"}`, "var(--green)", false, null, "calendar")}
        </div>
        <div class="grid-2 grid-2--side">
          <section class="panel">
            <div class="panel__head">
              <h2 class="panel__title">Maintenance history</h2>
              ${can("machines:log_notes") ? `<button class="btn btn--sm" id="h-note">${icons.plus} Log note</button>` : ""}
            </div>
            <div class="timeline" id="h-list"><div class="panel__body">${skeletonBlock(4)}</div></div>
            <div class="table-foot" id="h-foot"></div>
          </section>
          <section class="panel">
            <div class="panel__head"><h2 class="panel__title">Specification</h2></div>
            <div class="facts" style="grid-template-columns:1fr;border-left:0">
              ${spec("Department", machine.department)}
              ${spec("Location", machine.location)}
              ${spec("Manufacturer", machine.manufacturer)}
              ${spec("Model", machine.model)}
              ${spec("Serial number", machine.serial_number, true)}
              ${spec("Install date", machine.install_date, true)}
              ${spec("Registered", fmt.dateTime(machine.created_at), true)}
            </div>
          </section>
        </div>`;

      if (snap) applyMorph(root, snap);
      countUpAll(root.querySelector("#m-stats"), COUNT_FORMATS);
      const editBtn = root.querySelector("#m-edit");
      if (editBtn) editBtn.addEventListener("click", () => openMachineForm(machine));
      const retireBtn = root.querySelector("#m-retire");
      if (retireBtn) retireBtn.addEventListener("click", () => openRetire(machine));
      const noteBtn = root.querySelector("#h-note");
      if (noteBtn) noteBtn.addEventListener("click", () => openNote(machine));

      let page = 1;
      const entries = [];
      await loadHistory();

      async function loadHistory() {
        const foot = root.querySelector("#h-foot");
        try {
          const data = await api(`/machines/${id}/history`, { query: { page, per_page: 15 } });
          if (!alive || !root.querySelector("#h-list")) return;
          const firstNew = entries.length;
          entries.push(...data.history);
          const list = root.querySelector("#h-list");
          // Only the newly loaded entries animate in (staggered).
          list.innerHTML = entries.length
            ? entries.map((h, i) => historyItem(h, i >= firstNew ? i - firstNew : -1, h.id === highlightEntry)).join("")
            : emptyState("No maintenance recorded", "History entries appear when work orders on this machine are completed.", "calendar");
          const p = data.pagination;
          foot.innerHTML = `<span>${entries.length} OF ${p.total} ENTRIES</span>` +
            (p.page < p.pages ? `<button class="btn btn--sm" id="h-more">Load older</button>` : "");
          const more = foot.querySelector("#h-more");
          if (more) more.addEventListener("click", () => withBusy(more, async () => { page += 1; await loadHistory(); }));
        } catch (err) {
          const list = alive && root.querySelector("#h-list");
          if (list) {
            // Keep entries already shown (e.g. "Load older" failed); append the error with a retry.
            list.insertAdjacentHTML(entries.length ? "beforeend" : "afterbegin", errorState("Could not load history", err.message));
            if (!entries.length) list.querySelectorAll(".skeleton-block").forEach((s) => s.parentElement.remove());
            list.querySelector("[data-retry]").addEventListener("click", (ev) => {
              ev.currentTarget.closest(".error-state").remove();
              loadHistory();
            });
          }
        }
      }

      function openNote(m) {
        const modal = openModal({
          title: "Log maintenance note", eyebrow: `${m.machine_code} · ${m.name}`,
          body: `<form class="form" novalidate>
            <div class="form__error" role="alert"></div>
            <div class="form-grid">
              ${field({ name: "work_performed", label: "Note / work performed", type: "textarea", required: true, span: true, attrs: 'rows="4" autofocus maxlength="5000"' })}
              ${field({ name: "maintenance_type", label: "Type", options: CATEGORIES.map((c) => option(c, c, c === "Inspection")).join("") })}
              ${field({ name: "maintenance_date", label: "Date", type: "date", value: todayIso(), attrs: `max="${todayIso()}"` })}
              ${field({ name: "downtime_hours", label: "Downtime (hours)", type: "number", attrs: 'min="0" step="0.25" inputmode="decimal"' })}
              <div></div>
              ${field({ name: "labour_cost", label: "Labour cost", type: "number", attrs: 'min="0" step="0.01" inputmode="decimal"' })}
              ${field({ name: "material_cost", label: "Material cost", type: "number", attrs: 'min="0" step="0.01" inputmode="decimal"' })}
              ${field({ name: "remarks", label: "Remarks", type: "textarea", span: true, attrs: 'rows="2" maxlength="5000"' })}
            </div>
          </form>`,
          foot: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-save>Save note</button>`,
        });
        const form = modal.body.querySelector("form");
        const save = () => {
          clearErrors(form);
          const v = formValues(form);
          const errors = collect({
            work_performed: [check.required(v.work_performed, "Note")],
            maintenance_date: [v.maintenance_date > todayIso() ? "Date can't be in the future" : ""],
            downtime_hours: [check.decimal(v.downtime_hours, { min: 0 })],
            labour_cost: [check.decimal(v.labour_cost, { min: 0 })],
            material_cost: [check.decimal(v.material_cost, { min: 0 })],
          });
          if (!showErrors(form, errors)) return;
          const body = { work_performed: v.work_performed, maintenance_type: v.maintenance_type };
          if (v.maintenance_date) body.maintenance_date = v.maintenance_date;
          for (const k of ["downtime_hours", "labour_cost", "material_cost"]) if (v[k] !== "") body[k] = Number(v[k]);
          if (v.remarks) body.remarks = v.remarks;
          withBusy(modal.foot.querySelector("[data-save]"), async () => {
            try {
              const { history_entry: entry } = await api(`/machines/${m.id}/history`, { method: "POST", body });
              modal.close();
              toast("Note added to maintenance history");
              renderDetail(m.id, { highlightEntry: entry.id });   // refresh stats + timeline
            } catch (err) { showServerError(form, err); }
          });
        };
        modal.foot.querySelector("[data-save]").addEventListener("click", save);
        form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
      }
    }

    /** Stat card with icon badge; `format` (int|money|hours) makes the value count up. */
    function stat(label, value, sub, tone, alert = false, format = null, icon = "layers") {
      const valueHtml = format
        ? `<div class="stat__value stat__value--md" data-countup data-format="${format}" data-value="${Number(value) || 0}">${esc(COUNT_FORMATS[format](0))}</div>`
        : `<div class="stat__value stat__value--md">${esc(value)}</div>`;
      return `<div class="stat stat-card${alert ? " stat--alert" : ""}" style="--tone:${tone}">
        <div class="stat-card__top">${iconBadge(icon, tone)}</div>
        <div class="label">${esc(label)}</div>${valueHtml}<div class="stat__sub">${esc(sub)}</div></div>`;
    }

    function spec(label, value, mono = false) {
      return `<div class="fact"><div class="label">${esc(label)}</div><div class="fact__value${mono ? " mono" : ""}">${value ? esc(value) : '<span class="muted">—</span>'}</div></div>`;
    }

    /** enterIndex >= 0: animate in with that stagger slot. */
    function historyItem(h, enterIndex = -1, isNew = false) {
      const wo = h.work_order;
      const cls = `${enterIndex >= 0 ? " fade-up" : ""}${isNew ? " is-new" : ""}`;
      return `<article class="tl-item${cls}" style="--i:${Math.max(enterIndex, 0)}">
        <div class="tl-date">${fmt.date(h.maintenance_date)}<small>${esc(h.maintenance_type.toUpperCase())}</small></div>
        <div>
          <div class="tl-body__head">
            ${wo ? `<a class="mono" href="#/work-orders/${wo.id}">${fmt.woId(wo.id)}</a> <span class="cell-title">${esc(wo.title)}</span> ${statusBadge(wo.status)}`
                 : `<span class="chip">Log note</span>`}
          </div>
          <div class="tl-body__text">${esc(h.work_performed)}</div>
          ${h.remarks ? `<div class="tl-body__remarks">${esc(h.remarks)}</div>` : ""}
          <div class="tl-body__meta">
            <span>BY <b>${h.performed_by ? esc(h.performed_by.full_name) : "—"}</b></span>
            <span>DOWNTIME <b>${fmt.num(h.downtime_hours)} h</b></span>
            <span>LABOUR <b>${fmt.money(h.labour_cost)}</b></span>
            <span>MATERIAL <b>${fmt.money(h.material_cost)}</b></span>
            <span>TOTAL <b>${fmt.money(h.total_cost)}</b></span>
          </div>
        </div>
      </article>`;
    }

    return {
      // List <-> detail: slide forward into a machine, back out to the list.
      update(newParams) {
        swapContent(root, () => { render(newParams); window.scrollTo(0, 0); }, { dir: newParams[0] ? 1 : -1 });
      },
      destroy() { alive = false; },
    };
  },
};
