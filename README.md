# Work Order Management System

Flask + MySQL backend, static HTML/CSS/JS frontend.

```
backend/     Flask app (app.py, config.py, models/, routes/, scripts/)
database/    schema.sql, create_app_user.sql
frontend/    static HTML/CSS/JS (served separately)
```

## Setup (Windows, PowerShell)

Commands below assume MySQL 8.4 at the default install path. Run them from the project root.

```powershell
$mysql = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"

# 1. Create the database, tables and triggers (asks for the root password)
Get-Content database\schema.sql -Raw | & $mysql -u root -p

# 2. Edit database\create_app_user.sql and replace CHANGE_ME_STRONG_PASSWORD, then:
Get-Content database\create_app_user.sql -Raw | & $mysql -u root -p

# 3. Put the same password in backend\.env (copy from .env.example if missing):
#      DB_USER=wo_app
#      DB_PASSWORD=<the password from step 2>

# 4. Virtual environment + packages
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 5. Verify the connection
python scripts\check_db.py

# 6. Run the app, then open http://127.0.0.1:5000 (the frontend) - API health: /api/health
python app.py
```

## Frontend

Plain HTML/CSS/JS in `frontend/`, served by Flask at `/` (same origin as the API, so no CORS setup).

- `index.html` - shell; `css/app.css` - design system; `js/app.js` - login, navigation, hash router
- `js/api.js` - fetch wrapper; `js/session.js` - current user + permission mirror; `js/ui.js` - modals, toasts, forms
- `js/views/` - `dashboard.js`, `work-orders.js`, `machines.js`, `users.js`

Signing in sets an **HttpOnly, SameSite=Strict cookie** (`wo_token`) - nothing is kept in localStorage and
JavaScript can't read the token. Cookie-authenticated writes must send `X-Requested-With: fetch` (CSRF guard).
API clients can keep using `Authorization: Bearer <token>`. In production serve over HTTPS and keep
`AUTH_COOKIE_SECURE=true` (the default when `FLASK_ENV=production`).

Chart.js and the Google fonts load from CDNs; without internet the app still works (system fonts, charts show a notice).

### Create users

Nobody can log in until a user exists. Create the first Admin (you'll be prompted for a password):

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\create_user.py --username admin --full-name "Site Admin" --email admin@example.com --role Admin
```

After that, Admins can create users through `POST /api/users`.

## API (so far)

All endpoints except login and health need `Authorization: Bearer <access_token>`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | anyone | Server + DB status |
| POST | `/api/auth/login` | anyone | `{username, password}` (username or email) -> token |
| POST | `/api/auth/logout` | anyone | Clear the browser session cookie |
| GET | `/api/auth/me` | logged in | Current user |
| POST | `/api/auth/change-password` | logged in | `{current_password, new_password}` -> new token |
| GET | `/api/users` | Admin, Supervisor | Admin: all (`?role=&is_active=&q=`); Supervisor: active technicians |
| POST | `/api/users` | Admin | Create user |
| GET | `/api/users/<id>` | Admin; Supervisor (technicians); self | View user |
| PATCH | `/api/users/<id>` | Admin | Edit user / reset password / reactivate |
| DELETE | `/api/users/<id>` | Admin | Deactivate (users are never hard-deleted) |
| GET | `/api/users/roles` | logged in | Valid role names |

### Work orders

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/work-orders` | Admin, Supervisor | Create. Required: `title`, `machine_id`. Giving `assigned_technician_id` starts it as Assigned |
| GET | `/api/work-orders` | all (technicians: own only) | List. Filters: `status`, `priority`, `category` (comma-separated OK), `assignee` (id / `me` / `unassigned`), `department`, `machine_id`, `overdue=true`, `q`. Also `page`, `per_page`, `sort` (e.g. `-priority`) |
| GET | `/api/work-orders/<id>` | all (technicians: own only) | Detail with materials, costs, `allowed_transitions` |
| PUT | `/api/work-orders/<id>` | Admin, Supervisor; technicians: `progress` only | Partial edit (send only changed fields) |
| PATCH | `/api/work-orders/<id>/status` | depends on transition | `{"status": "..."}` - see workflow below |
| DELETE | `/api/work-orders/<id>` | Admin | Delete (materials go with it; history is kept) |
| POST | `/api/work-orders/<id>/materials` | Admin, Supervisor, assigned technician | `{material_name, quantity, unit_cost, unit?, part_number?}` |
| POST | `/api/work-orders/<id>/labour-cost` | Admin, Supervisor, assigned technician | `{hours, hourly_rate?}` - adds hours |

Every work-order response includes `labour_cost`, `material_cost` and `total_cost`, calculated by MySQL.

Workflow (`backend/workflow.py`):

| From -> To | Who |
|---|---|
| Pending -> Assigned | Supervisor/Admin (needs a technician) |
| Assigned -> In Progress, In Progress <-> On Hold, In Progress -> Completed | Assigned technician/Admin |
| Completed -> In Progress (rework), Completed -> Verified | Supervisor/Admin |
| Verified -> Closed | Supervisor/Admin |

Verified and Closed work orders are locked.

### Machines, maintenance history, dashboard

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/machines` | Admin, Supervisor | Register. Required: `machine_code`, `name`, `department`. Optional: `install_date`, `location`, `manufacturer`, `model`, `serial_number`, `status` |
| GET | `/api/machines` | all | List with `open_work_orders`. Filters: `department`, `status`, `q`, `page`, `per_page` |
| GET | `/api/machines/<id>` | all | Detail + stats (work orders, maintenance cost, downtime, last maintenance) |
| GET | `/api/machines/<id>/history` | all | Maintenance history, newest first (paginated) |
| POST | `/api/machines/<id>/history` | all | Manual log note: `{work_performed, maintenance_type?, maintenance_date?, downtime_hours?, labour_cost?, material_cost?, remarks?}` |
| GET | `/api/dashboard/summary` | all (technicians: own work) | Counts by status, open by priority, overdue, cost this month, cost by month (last 6) |

| PUT | `/api/machines/<id>` | Admin, Supervisor | Edit (send only changed fields). Status can't be set to Retired here |
| PATCH | `/api/machines/<id>/retire` | Admin, Supervisor | `{"retired": true, "reason"?}` retire (blocked while it has open work orders) / `{"retired": false}` reactivate |
| PUT | `/api/work-orders/<id>/materials/<mid>` | Admin, Supervisor, assigned technician | Edit a logged material; cost recalculated by trigger |
| DELETE | `/api/work-orders/<id>/materials/<mid>` | Admin, Supervisor, assigned technician | Remove a logged material; cost recalculated |
| GET | `/api/audit-log` | Admin | Activity log. Filters: `actor_id`, `action`, `category`, `entity_type`+`entity_id`, `date_from`/`date_to`, `q`; paging `per_page` + `before_id` |
| GET | `/api/audit-log/filters` | Admin | Filter options (actions, people in the log) |
| PUT | `/api/work-orders/<id>/rating` | Admin, Supervisor | `{stars: 1-5, comment?}` rate the technician on a Verified/Closed work order (replaces any earlier rating). Can also be sent as `rating` + `rating_comment` with the status change to Verified or Closed |
| GET | `/api/users/<id>/ratings` | Admin, Supervisor; the technician themselves | Average + count. Admin/Supervisor also get the star breakdown and latest ratings with comments; technicians see only their own average |
| POST | `/api/work-orders/<id>/materials/<mid>/photo` | Admin, Supervisor, assigned technician | multipart field `photo` (JPEG/PNG/WebP/HEIC/GIF, max 10 MB). One photo per material, stored in Cloudinary |
| POST | `/api/work-orders/<id>/materials/<mid>/photo/check` | as above | Run the experimental AI check (re-runs only if there's no usable result or the material was renamed) |
| PATCH | `/api/work-orders/<id>/materials/<mid>/photo/review` | Admin, Supervisor | `{decision: "Approved" / "Rejected" / null, note?}`: the supervisor's own call; the AI hint never decides |
| DELETE | `/api/work-orders/<id>/materials/<mid>/photo` | Admin, Supervisor, assigned technician | Remove the photo |
| GET | `/api/dashboard/staffing` | Admin, Supervisor | Rule-based staffing estimate (see `backend/staffing.py`) with every figure it used |

Retired machines keep all history and past work orders but can't be used for new work orders.
Material edits/deletes are allowed only while costs are open (Assigned, In Progress, On Hold, Completed).

### Activity log (migration 002)

Existing databases need the `audit_log` table (new installs get it from `schema.sql`). Run once as root:

```powershell
cd "C:\Users\DRAGON\Downloads\Work order"
$mysql = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
Get-Content .\database\migrations\002_audit_log.sql -Raw | & $mysql -u root -p
cd backend; .\.venv\Scripts\python.exe scripts\check_db.py     # should list audit_log
```

Until it exists the app keeps working, logs a warning, and the Activity Log page shows these instructions.
Entries are written in the same transaction as the change they describe. Logged: work-order
create/edit/status/delete, labour, material add/edit/delete, machine create/edit/retire/reactivate,
maintenance notes, user create/edit/deactivate/reactivate, password resets and changes (never the password itself).

### Ratings + material photos (migration 004)

Existing databases need the `technician_ratings` and `material_photos` tables (new installs get them from
`schema.sql`). Run once as root:

```powershell
cd "C:\Users\DRAGON\Downloads\Work order"
$mysql = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
Get-Content .\database\migrations\004_ratings_and_photos.sql -Raw | & $mysql -u root -p
cd backend; .\.venv\Scripts\python.exe scripts\check_db.py     # should list both tables
```

Until it runs, the app keeps working with ratings and photos switched off (the API answers 503 with
these instructions).

- **Ratings**: optional 1-5 stars (+ comment) when a supervisor verifies or closes work, or later from
  the work order. One rating per work order; kept if the work order is deleted. Averages show on the
  Users page and the technician's profile; technicians see their own average (sidebar + user menu),
  never individual comments.
- **Material photos** need Cloudinary credentials, and the **AI check** needs a Google Gemini API key. Both
  are optional (see *Optional environment variables* below). Without Cloudinary the photo field is hidden;
  without the Gemini key photos show "No AI check". The AI check is an experimental hint for the
  supervisor, never a gate: failures, timeouts and refusals all leave the photo reviewable.
- **Staffing insight** (dashboard, Admin/Supervisor) is a fixed rule over the last 4 weeks of work
  orders: no model, no external service. The info button on the panel shows the full calculation.

### Login throttling (migration 003)

Existing databases need the `login_attempts` table (new installs get it from `schema.sql`). Run once as root:

```powershell
cd "C:\Users\DRAGON\Downloads\Work order"
$mysql = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe"
Get-Content .\database\migrations\003_login_attempts.sql -Raw | & $mysql -u root -p
cd backend; .\.venv\Scripts\python.exe scripts\check_db.py     # should list login_attempts
```

Unlike the audit log, this table is required - it's what enforces `LOGIN_MAX_FAILURES` per
username+IP, and failing to create it means every login attempt gets a 500, not a soft warning.
It's kept in the database (not in memory) so the limit holds across multiple gunicorn workers and
survives restarts; rows are pruned automatically as new failures are recorded.

Maintenance history is automatic (`backend/maintenance.py`): one entry per work order, created on **Completed**, refreshed on **Verified**/**Closed** and whenever costs change while Completed, removed if the work is sent back for rework. `work_performed`, `downtime_hours` and `remarks` can be sent with the Completed or Verified status change. Dashboard costs are the costs of finished work (from history), counted in the month it was completed.

Status codes: 400 invalid input, 401 not logged in, 403 role not allowed, 404 not found (or not yours),
409 not allowed in the current status, 413 body over 1 MB, 429 too many failed sign-ins
(`LOGIN_MAX_FAILURES` per username+IP within `LOGIN_LOCKOUT_SECONDS`), 503 database unavailable.
Every error is JSON: `{"error": "<message>"}`. Unknown fields are rejected, not ignored.

Sample machines: `python scripts\seed_machines.py`.

Role rules live in `backend/auth/rbac.py` (`PERMISSIONS`). Admin passes every check.

PowerShell has no `<` input redirection, so the scripts are piped in with `Get-Content`.
In cmd.exe you can use `mysql -u root -p < database\schema.sql` instead.
In MySQL Workbench: File > Open SQL Script > schema.sql, then run it with the lightning-bolt button.

If `Activate.ps1` is blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## Deploying (Railway)

Railway runs this as an always-on gunicorn process, not serverless - no code changes needed beyond
what's already here (`Procfile`, root `requirements.txt`, `backend/config.py` reading everything
from the environment).

- **Don't set a "Root Directory"** on the Railway service (leave it as the repo root). `backend/`,
  `frontend/` and `database/` are siblings, and Flask serves `../frontend` by relative path from
  `backend/app.py` - narrowing the build to `backend/` would hide `frontend/` from the build entirely.
  The root `requirements.txt` (`-r backend/requirements.txt`) and root `Procfile`
  (`gunicorn --chdir backend --bind 0.0.0.0:$PORT app:app`) exist so Nixpacks still auto-detects
  Python and gunicorn still finds `app:app`, without needing a narrowed root.
- Provision a MySQL database (Railway's plugin or an external one) and run `database/schema.sql`,
  then `database/create_app_user.sql`, against it - same as the local setup above, just pointed at
  the Railway database's host/port instead of localhost.
- Set every variable listed under "Environment variables" in the deployment notes (SECRET_KEY,
  DB_*, FLASK_ENV=production, etc.) in the Railway service's Variables tab - `backend/.env` is
  git-ignored and never read in production.
- `FLASK_ENV` should be set to `production` explicitly. If it's ever left unset or misspelled, the
  app now fails safe into the production config (no debug mode, no dev SECRET_KEY, Secure cookies)
  rather than silently running with development defaults.
- If the Railway database was created before ratings/photos existed, run
  `database/migrations/004_ratings_and_photos.sql` against it too (as its root user).

### Optional environment variables

Set locally in `backend/.env`, and on Railway in the web service's **Variables** tab (Railway redeploys
on change). Leaving any of them out just switches that feature off.

| Variable | Feature | Where to get it |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | Material photos | Cloudinary console -> Dashboard -> Product Environment Credentials |
| `CLOUDINARY_API_KEY` | Material photos | same place |
| `CLOUDINARY_API_SECRET` | Material photos | same place (keep secret) |
| `GEMINI_API_KEY` | Experimental AI photo check | aistudio.google.com -> Get API key (free tier, no billing) |
| `PHOTO_CHECK_MODEL` | AI check model (optional) | defaults to `gemini-3.8-flash` |

Each AI check is one Gemini request with one image. On Google's free tier it costs nothing, but it is
rate-limited (a busy period shows "try again in a minute" on the photo) and Google states that free-tier
content may be used to improve its products - i.e. material photos are shared with Google on those terms.
If that matters, enable billing on the Google project (paid-tier content isn't used that way). A finished
check isn't re-run, so repeat clicks don't use up quota.
