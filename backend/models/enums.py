"""Allowed values for ENUM columns. Must match database/schema.sql."""

ROLES = ("Admin", "Supervisor", "Technician")

PRIORITIES = ("Low", "Medium", "High", "Critical")

WORK_ORDER_STATUSES = (
    "Pending",
    "Assigned",
    "In Progress",
    "On Hold",
    "Completed",
    "Verified",
    "Closed",
)

MAINTENANCE_CATEGORIES = (
    "Preventive",
    "Corrective",
    "Breakdown",
    "Inspection",
    "Calibration",
    "Installation",
    "Other",
)

MACHINE_STATUSES = ("Operational", "Under Maintenance", "Breakdown", "Retired")
