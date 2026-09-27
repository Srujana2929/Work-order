"""Work order status workflow.

    Pending -> Assigned -> In Progress <-> On Hold
                               |
                               v
                           Completed -> Verified -> Closed
                               |
                               +-> In Progress   (sent back for rework)

Each allowed transition names the permission (see auth/rbac.py) needed to
make it. Anything not listed here is rejected.
"""
from auth.rbac import has_permission

TRANSITIONS = {
    ("Pending", "Assigned"):        "work_orders:assign",
    ("Assigned", "In Progress"):    "work_orders:update_work",
    ("In Progress", "On Hold"):     "work_orders:update_work",
    ("On Hold", "In Progress"):     "work_orders:update_work",
    ("In Progress", "Completed"):   "work_orders:update_work",
    ("Completed", "In Progress"):   "work_orders:verify",    # rework
    ("Completed", "Verified"):      "work_orders:verify",
    ("Verified", "Closed"):         "work_orders:close",
}

# Statuses in which a given kind of change is still allowed.
LOCKED_STATUSES = ("Verified", "Closed")                           # no edits at all
PROGRESS_STATUSES = ("Assigned", "In Progress", "On Hold")         # progress %
REASSIGN_STATUSES = ("Pending", "Assigned", "In Progress", "On Hold")
COST_STATUSES = ("Assigned", "In Progress", "On Hold", "Completed")  # materials/labour


def next_statuses(current_status):
    """All statuses reachable from current_status (ignoring permissions)."""
    return [to for (frm, to) in TRANSITIONS if frm == current_status]


def allowed_transitions(user, work_order):
    """Statuses this user may move this work order to right now."""
    return [to for to in next_statuses(work_order.status)
            if has_permission(user, TRANSITIONS[(work_order.status, to)])]
