// Users (Admin only): accounts, roles, activation, password resets.
import { api } from "../api.js";
import { renderRows, skeletonRows } from "../motion.js";
import { session } from "../session.js";
import {
  check, clearErrors, collect, confirmDialog, debounce, emptyRow, errorRow, esc, field, fmt,
  formValues, icons, initials, openModal, option, setPage, showErrors,
  showServerError, toast, withBusy,
} from "../ui.js";

const ROLES = ["Admin", "Supervisor", "Technician"];
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,50}$/;
const filters = { q: "", role: "", active: "true" };

export default {
  reset() { Object.assign(filters, { q: "", role: "", active: "true" }); },   // on sign-out
  mount(root) {
    setPage("Users", ["Administration"]);
    let alive = true;
    let seq = 0;
    let rows = [];
    let justCreated = null;   // id of a user to highlight on the next render

    root.innerHTML = `
      <div class="toolbar">
        <div class="search">${icons.search}<input id="u-q" type="search" placeholder="Search name, username, email…" aria-label="Search users"></div>
        <div class="field"><label for="u-role">Role</label><select id="u-role">${option("", "All roles")}${ROLES.map((r) => option(r, r, r === filters.role)).join("")}</select></div>
        <div class="field"><label for="u-active">Account</label><select id="u-active">
          ${option("true", "Active", filters.active === "true")}${option("false", "Deactivated", filters.active === "false")}${option("", "All", filters.active === "")}
        </select></div>
        <div class="spacer"></div>
        <button class="btn btn--accent" id="u-new">${icons.plus} New user</button>
      </div>
      <section class="panel">
        <div class="table-wrap"><table class="data" id="u-table">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Department</th><th>Phone</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${skeletonRows(8, 5)}</tbody>
        </table></div>
        <div class="table-foot"><span id="u-count"></span></div>
      </section>`;

    const $ = (s) => root.querySelector(s);
    $("#u-q").value = filters.q;
    $("#u-q").addEventListener("input", debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
    $("#u-role").addEventListener("change", (e) => { filters.role = e.target.value; load(); });
    $("#u-active").addEventListener("change", (e) => { filters.active = e.target.value; load(); });
    $("#u-new").addEventListener("click", () => openForm(null));
    $("#u-table tbody").addEventListener("click", async (e) => {
      if (e.target.closest("[data-retry]")) { load(); return; }
      const btn = e.target.closest("button[data-act]");
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      const user = rows.find((u) => String(u.id) === tr.dataset.id);
      if (btn && btn.dataset.act === "toggle") { e.stopPropagation(); toggleActive(user, btn); return; }
      openForm(user);
    });

    load();

    async function load() {
      const mine = ++seq;
      $("#u-table").classList.add("is-loading");
      try {
        const data = await api("/users", { query: { q: filters.q, role: filters.role, is_active: filters.active } });
        if (mine !== seq || !alive) return;
        rows = data.users;
        const me = session.user.id;
        renderRows($("#u-table tbody"), rows.length ? rows.map((u) => `
          <tr class="clickable${u.is_active ? "" : " is-inactive"}" data-id="${u.id}">
            <td><div class="person"><span class="avatar avatar--sm avatar--${esc(u.role.toLowerCase())}" aria-hidden="true">${esc(initials(u.full_name))}</span>
                <div><div class="cell-title">${esc(u.full_name)}${u.id === me ? ' <span class="chip">You</span>' : ""}</div><div class="cell-sub">${esc(u.email)}</div></div></div></td>
            <td class="mono">${esc(u.username)}</td>
            <td><span class="role-tag role-tag--${esc(u.role.toLowerCase())}">${esc(u.role)}</span></td>
            <td>${esc(u.department || "—")}</td>
            <td class="mono nowrap">${esc(u.phone || "—")}</td>
            <td>${u.is_active ? '<span class="chip chip--green">Active</span>' : '<span class="chip chip--red">Deactivated</span>'}</td>
            <td class="mono nowrap">${fmt.date(u.created_at)}</td>
            <td class="nowrap" style="text-align:right">
              ${u.id === me ? "" : `<button class="btn btn--sm ${u.is_active ? "btn--danger" : ""}" data-act="toggle">${u.is_active ? "Deactivate" : "Reactivate"}</button>`}
            </td>
          </tr>`).join("")
          : emptyRow(8, "No users match", "Try a different search or filter."),
          { highlight: justCreated });
        justCreated = null;
        $("#u-count").textContent = `${rows.length} USER${rows.length === 1 ? "" : "S"}`;
      } catch (err) {
        if (mine === seq && alive) renderRows($("#u-table tbody"), errorRow(8, "Could not load users", err.message));
      } finally {
        if (mine === seq) $("#u-table").classList.remove("is-loading");
      }
    }

    async function toggleActive(user, btn) {
      if (user.is_active) {
        const ok = await confirmDialog({
          title: `Deactivate ${user.full_name}?`, danger: true, confirmLabel: "Deactivate",
          message: "They are signed out immediately and can't sign in again until reactivated. Their work-order history is kept.",
        });
        if (!ok) return;
      }
      await withBusy(btn, async () => {
        try {
          if (user.is_active) await api(`/users/${user.id}`, { method: "DELETE" });
          else await api(`/users/${user.id}`, { method: "PATCH", body: { is_active: true } });
          toast(`${user.full_name} ${user.is_active ? "deactivated" : "reactivated"}`);
        } catch (err) { toast(err.message, "error"); }
      });
      load();
    }

    function openForm(user) {
      const editing = Boolean(user);
      const self = editing && user.id === session.user.id;
      const modal = openModal({
        title: editing ? "Edit user" : "New user",
        eyebrow: editing ? `${user.username} · #${user.id}` : "Create an account",
        body: `<form class="form" novalidate autocomplete="off">
          <div class="form__error" role="alert"></div>
          <div class="form-grid">
            ${field({ name: "full_name", label: "Full name", required: true, value: user ? user.full_name : "", attrs: 'maxlength="100" autofocus' })}
            ${field({ name: "username", label: "Username", required: true, value: user ? user.username : "", hint: "3–50 characters: letters, digits, _ . -", attrs: 'maxlength="50" autocomplete="off"' })}
            ${field({ name: "email", label: "Email", type: "email", required: true, value: user ? user.email : "", attrs: 'maxlength="120"' })}
            ${field({ name: "role", label: "Role", required: true, attrs: self ? "disabled" : "",
                      options: ROLES.map((r) => option(r, r, user ? user.role === r : r === "Technician")).join(""),
                      hint: self ? "You can't change your own role." : "" })}
            ${field({ name: "department", label: "Department", value: user ? user.department || "" : "", attrs: 'maxlength="100"' })}
            ${field({ name: "phone", label: "Phone", type: "tel", value: user ? user.phone || "" : "", attrs: 'maxlength="20"' })}
          </div>
          <div class="form-section">${editing ? "Reset password (optional)" : "Password"}</div>
          <div class="form-grid">
            ${field({ name: "password", label: editing ? "New password" : "Password", type: "password", required: !editing, hint: "At least 8 characters.", attrs: 'autocomplete="new-password"' })}
            ${field({ name: "confirm", label: "Confirm password", type: "password", required: !editing, attrs: 'autocomplete="new-password"' })}
          </div>
          ${editing && !self ? `<label class="field field--inline"><input type="checkbox" name="is_active" ${user.is_active ? "checked" : ""}> <span class="field__label">Account active</span></label>` : ""}
          ${editing && self ? `<div class="notice">To change your own password use “Password” in the sidebar.</div>` : ""}
        </form>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-save>${editing ? "Save changes" : "Create user"}</button>`,
      });
      const form = modal.body.querySelector("form");
      if (self) { form.elements.password.disabled = true; form.elements.confirm.disabled = true; }

      const save = () => {
        clearErrors(form);
        const v = formValues(form);
        const wantsPassword = !editing || (v.password || "") !== "";
        const errors = collect({
          full_name: [check.required(v.full_name, "Full name")],
          username: [check.required(v.username, "Username"), v.username && !USERNAME_RE.test(v.username) ? "3–50 characters: letters, digits, _ . -" : ""],
          email: [check.required(v.email, "Email"), check.email(v.email)],
          password: [wantsPassword && !self ? (check.required(v.password, "Password") || (v.password.length < 8 ? "Must be at least 8 characters" : "")) : ""],
          confirm: [wantsPassword && !self && v.confirm !== v.password ? "Passwords do not match" : ""],
        });
        if (!showErrors(form, errors)) return;

        const payload = {
          full_name: v.full_name, username: v.username, email: v.email.toLowerCase(),
          department: v.department || null, phone: v.phone || null,
        };
        if (!self) payload.role = v.role;
        if (wantsPassword && !self) payload.password = v.password;
        if (editing && !self) payload.is_active = v.is_active;

        let body = payload;
        if (editing) {
          const original = { full_name: user.full_name, username: user.username, email: user.email, role: user.role,
                             department: user.department || null, phone: user.phone || null, is_active: user.is_active };
          body = Object.fromEntries(Object.entries(payload).filter(([k, val]) => k === "password" || val !== original[k]));
          if (!Object.keys(body).length) { modal.close(); toast("No changes to save", "warn"); return; }
        } else {
          for (const k of ["department", "phone"]) if (body[k] === null) delete body[k];
        }

        withBusy(modal.foot.querySelector("[data-save]"), async () => {
          try {
            const res = await api(editing ? `/users/${user.id}` : "/users", { method: editing ? "PATCH" : "POST", body });
            modal.close();
            toast(editing ? `${res.user.full_name} updated${body.password ? " · password reset" : ""}` : `${res.user.full_name} created`);
            if (self) { session.user = res.user; }
            if (!editing) justCreated = res.user.id;
            load();
          } catch (err) { showServerError(form, err); }
        });
      };
      modal.foot.querySelector("[data-save]").addEventListener("click", save);
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    }

    return { destroy() { alive = false; } };
  },
};
