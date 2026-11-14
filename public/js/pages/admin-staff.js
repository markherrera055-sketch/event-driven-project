/** Admin Console — Administrator.manageStaffAccounts() (DFD 10.0, D8 Staff). */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, raw, setHTML, dateTime, badge, errorHTML, emptyHTML, loadingHTML, openModal, toast, toastError, session, passwordField } from "../core/ui.js";
import { PASSWORD_HINT, passwordFeedbackHTML, bindPasswordFeedback } from "../core/password.js";

const root = $("#page-root");
setHTML(root, html`<div class="card"><div class="toolbar"><input type="search" id="search" placeholder="Name or username…" aria-label="Search staff"></div><div id="results"></div></div>`);
const results = $("#results");
let staff = [];

const roleSelect = (selected = "RECEPTIONIST") => html`<select name="role" required>
  <option value="RECEPTIONIST" ${selected === "RECEPTIONIST" ? raw("selected") : ""}>Receptionist — front-desk operations</option>
  <option value="ADMINISTRATOR" ${selected === "ADMINISTRATOR" ? raw("selected") : ""}>Administrator — rooms, staff and integrations</option></select>`;

const statusCell = (u) => html`${u.isActive ? html`<span class="badge badge-green">Active</span>` : html`<span class="badge">Deactivated</span>`}
  ${u.mustChangePassword && u.isActive ? html`<div class="sub"><span class="badge badge-amber plain">Must set new password</span></div>` : ""}`;

async function load() {
  setHTML(results, loadingHTML());
  try {
    staff = await api.get("/admin/staff", { search: $("#search").value.trim() });
    if (!staff.length) return setHTML(results, emptyHTML("No staff accounts found"));
    setHTML(
      results,
      html`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${staff.map((u) => html`<tr><td class="strong">${u.fullName}${u.id === session.userId ? html` <span class="sub">(you)</span>` : ""}</td><td class="mono">${u.username}</td>
        <td>${badge(u.role)}</td><td>${statusCell(u)}</td>
        <td>${u.lastLoginAt ? dateTime(u.lastLoginAt) : "Never"}</td>
        <td class="right"><div class="row">
          <button class="btn btn-sm" data-edit="${u.id}">Edit</button>
          ${u.id === session.userId
            ? html`<a class="btn btn-sm" href="/account">Change password</a>`
            : html`<button class="btn btn-sm" data-reset="${u.id}">Reset password</button>`}
        </div></td></tr>`)}
      </tbody></table></div>`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

$("#new-staff")?.addEventListener("click", async () => {
  try {
    const created = await openModal({
      title: "Add staff account",
      submitLabel: "Create account",
      body: html`<div class="field"><label>Full name</label><input name="fullName" required maxlength="120"></div>
        <div class="field"><label>Username</label><input name="username" required minlength="3" maxlength="50" autocomplete="off" pattern="[A-Za-z0-9._\\-]+" title="Letters, digits, . _ -"></div>
        ${passwordField({ name: "password", label: "Temporary password", hint: PASSWORD_HINT, extra: passwordFeedbackHTML() })}
        <div class="field"><label>Role</label>${roleSelect()}</div>
        <p class="hint">Give the temporary password to the staff member in person. They must choose their own password the first time they sign in.</p>`,
      onOpen: (form) => {
        const update = bindPasswordFeedback(form, { name: "password" });
        form.querySelector('[name="username"]').addEventListener("input", update);
      },
      onSubmit: (v) => api.post("/admin/staff", v),
    });
    if (created) {
      toast(`Account ${created.username} created. They will set their own password at first sign-in.`, "success");
      load();
    }
  } catch (err) {
    toastError(err);
  }
});

async function editStaff(u) {
  const updated = await openModal({
    title: `Edit ${u.fullName}`,
    body: html`<div class="field"><label>Full name</label><input name="fullName" value="${u.fullName}" required maxlength="120"></div>
      <div class="field"><label>Username</label><input name="username" value="${u.username}" required minlength="3" maxlength="50"></div>
      <div class="field"><label>Role</label>${roleSelect(u.role)}</div>
      <div class="field"><label class="check"><input type="checkbox" name="isActive" ${u.isActive ? raw("checked") : ""}> Account active (can sign in)</label>
        <div class="hint">Deactivating an account signs it out everywhere immediately.</div></div>
      <p class="hint">Passwords are never shown. ${u.id === session.userId ? "Change your own password from Account settings." : "Use “Reset password” to issue a temporary password."}</p>`,
    onSubmit: (v) => api.patch(`/admin/staff/${u.id}`, v),
  });
  if (updated) {
    toast("Account saved.", "success");
    load();
  }
}

/** Admin-initiated reset: generated (recommended) or admin-chosen temporary password. */
async function resetPassword(u) {
  const result = await openModal({
    title: `Reset password for ${u.fullName}`,
    submitLabel: "Reset password",
    danger: true,
    body: html`<p>The current password stops working immediately and <strong>${u.fullName}</strong> is signed out of every device.
        At the next sign-in they must choose a new password of their own.</p>
      <div class="stack">
        <label class="check"><input type="radio" name="mode" value="generate" checked> <span><strong>Generate a secure temporary password</strong> (recommended)<span class="hint">Shown to you once after the reset.</span></span></label>
        <label class="check"><input type="radio" name="mode" value="manual"> <span><strong>Set a temporary password myself</strong></span></label>
      </div>
      <div class="reset-manual hidden">${passwordField({ name: "temporaryPassword", label: "Temporary password", hint: PASSWORD_HINT, extra: passwordFeedbackHTML() })}</div>`,
    onOpen: (form) => {
      const manual = form.querySelector(".reset-manual");
      const input = form.querySelector('[name="temporaryPassword"]');
      const sync = () => {
        const on = form.querySelector('[name="mode"]:checked').value === "manual";
        manual.classList.toggle("hidden", !on);
        input.disabled = !on; // disabled fields are neither validated nor submitted
        if (on) input.focus();
      };
      form.querySelectorAll('[name="mode"]').forEach((r) => r.addEventListener("change", sync));
      bindPasswordFeedback(form, { name: "temporaryPassword", username: u.username });
      sync();
    },
    onSubmit: (v) => api.post(`/admin/staff/${u.id}/reset-password`, v.mode === "manual" ? { temporaryPassword: v.temporaryPassword } : {}),
  });
  if (!result) return;
  load();
  if (!result.temporaryPassword) {
    toast(`Password reset. ${u.fullName} must set a new password at next sign-in.`, "success");
    return;
  }
  await openModal({
    title: "Temporary password",
    cancelLabel: "Done",
    danger: true, // only affects button styling: the sole "Done" button is neutral instead of terracotta
    body: html`<p>Give this password to <strong>${u.fullName}</strong> (${u.username}) in person. It is shown only once and is not stored anywhere in readable form.</p>
      <div class="field"><label for="temp-pw">Temporary password</label>
        <div class="input-group"><input id="temp-pw" class="mono temp-password" value="${result.temporaryPassword}" readonly>
        <button type="button" class="input-addon" id="copy-temp-pw">Copy</button></div></div>
      <div class="alert alert-warning">They will be asked to replace it the first time they sign in.</div>`,
    onOpen: (form) => {
      const input = form.querySelector("#temp-pw");
      input.select();
      form.querySelector("#copy-temp-pw").addEventListener("click", async (e) => {
        try {
          await navigator.clipboard.writeText(input.value);
          e.target.textContent = "Copied";
        } catch {
          input.select();
          e.target.textContent = "Press Ctrl+C";
        }
      });
    },
  });
}

results.addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit]");
  const reset = e.target.closest("[data-reset]");
  const u = staff.find((x) => x.id === Number((edit || reset)?.dataset.edit || (edit || reset)?.dataset.reset));
  if (!u) return;
  try {
    if (edit) await editStaff(u);
    else await resetPassword(u);
  } catch (err) {
    toastError(err);
  }
});
let t;
$("#search").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 300); });
load();
