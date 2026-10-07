-- =====================================================================
-- Work Order Management System - MySQL 8.x schema
--
-- Run as root (or another account allowed to create databases and
-- triggers):
--   mysql -u root -p < database/schema.sql
--
-- Safe to re-run: tables are only created if missing and triggers are
-- recreated. It will NOT alter a table that already exists; to rebuild
-- from scratch, DROP DATABASE work_order_db first (destroys all data).
-- =====================================================================

CREATE DATABASE IF NOT EXISTS work_order_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE work_order_db;

-- ---------------------------------------------------------------------
-- users: Admin / Supervisor / Technician accounts.
-- Users are deactivated (is_active = 0), never deleted, so every FK that
-- points here uses ON DELETE RESTRICT to protect the audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    full_name       VARCHAR(100)    NOT NULL,
    username        VARCHAR(50)     NOT NULL,
    email           VARCHAR(120)    NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    role            ENUM('Admin', 'Supervisor', 'Technician') NOT NULL DEFAULT 'Technician',
    department      VARCHAR(100)    NULL,
    phone           VARCHAR(20)     NULL,
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email    UNIQUE (email),
    INDEX idx_users_role (role)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- machines: equipment / assets that work orders are raised against.
-- Retire a machine (status = 'Retired') instead of deleting it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS machines (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    machine_code    VARCHAR(30)     NOT NULL,           -- asset tag, e.g. CNC-001
    name            VARCHAR(120)    NOT NULL,
    department      VARCHAR(100)    NOT NULL,
    location        VARCHAR(120)    NULL,
    manufacturer    VARCHAR(100)    NULL,
    model           VARCHAR(100)    NULL,
    serial_number   VARCHAR(100)    NULL,
    install_date    DATE            NULL,
    status          ENUM('Operational', 'Under Maintenance', 'Breakdown', 'Retired')
                                    NOT NULL DEFAULT 'Operational',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT uq_machines_code   UNIQUE (machine_code),
    CONSTRAINT uq_machines_serial UNIQUE (serial_number),   -- multiple NULLs allowed
    INDEX idx_machines_department (department),
    INDEX idx_machines_status (status)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- work_orders
-- Workflow: Pending -> Assigned -> In Progress -> On Hold -> Completed
--           -> Verified -> Closed
-- Cost fields:
--   labour_cost   = labour_hours * labour_rate          (generated)
--   material_cost = SUM(materials.line_total)           (kept by triggers)
--   total_cost    = labour_cost + material_cost         (generated)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
    id                      INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    title                   VARCHAR(150)    NOT NULL,
    description             TEXT            NULL,
    machine_id              INT UNSIGNED    NOT NULL,
    department              VARCHAR(100)    NOT NULL,
    category                ENUM('Preventive', 'Corrective', 'Breakdown', 'Inspection',
                                 'Calibration', 'Installation', 'Other')
                                            NOT NULL DEFAULT 'Corrective',
    priority                ENUM('Low', 'Medium', 'High', 'Critical')
                                            NOT NULL DEFAULT 'Medium',
    status                  ENUM('Pending', 'Assigned', 'In Progress', 'On Hold',
                                 'Completed', 'Verified', 'Closed')
                                            NOT NULL DEFAULT 'Pending',
    assigned_technician_id  INT UNSIGNED    NULL,
    created_by              INT UNSIGNED    NULL,
    verified_by             INT UNSIGNED    NULL,
    progress                TINYINT UNSIGNED NOT NULL DEFAULT 0,      -- percent, 0-100

    labour_hours            DECIMAL(8,2)    NOT NULL DEFAULT 0.00,
    labour_rate             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,    -- cost per hour
    labour_cost             DECIMAL(12,2)   AS (ROUND(labour_hours * labour_rate, 2)) STORED,
    material_cost           DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    total_cost              DECIMAL(12,2)   AS (labour_cost + material_cost) STORED,

    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    due_date                DATE            NULL,
    started_at              DATETIME        NULL,
    completed_at            DATETIME        NULL,
    verified_at             DATETIME        NULL,
    closed_at               DATETIME        NULL,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    INDEX idx_wo_status (status),
    INDEX idx_wo_priority (priority),
    INDEX idx_wo_department (department),
    INDEX idx_wo_due_date (due_date),

    CONSTRAINT fk_wo_machine
        FOREIGN KEY (machine_id) REFERENCES machines (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_wo_technician
        FOREIGN KEY (assigned_technician_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_wo_created_by
        FOREIGN KEY (created_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_wo_verified_by
        FOREIGN KEY (verified_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT chk_wo_progress      CHECK (progress BETWEEN 0 AND 100),
    CONSTRAINT chk_wo_labour        CHECK (labour_hours >= 0 AND labour_rate >= 0),
    CONSTRAINT chk_wo_material_cost CHECK (material_cost >= 0),
    CONSTRAINT chk_wo_due_date      CHECK (due_date IS NULL OR due_date >= DATE(created_at)),
    -- "Anything past Pending must have a technician" is enforced by the
    -- trg_work_orders_before_* triggers below: MySQL forbids a CHECK on a
    -- column that has a foreign key referential action (error 3823).
    -- Finished work is 100% done.
    CONSTRAINT chk_wo_done_progress CHECK (status NOT IN ('Completed', 'Verified', 'Closed') OR progress = 100)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- materials: parts/consumables used on a work order.
-- Deleted automatically with their work order.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS materials (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    work_order_id   INT UNSIGNED    NOT NULL,
    material_name   VARCHAR(120)    NOT NULL,
    part_number     VARCHAR(60)     NULL,
    quantity        DECIMAL(10,2)   NOT NULL,
    unit            VARCHAR(20)     NOT NULL DEFAULT 'pcs',
    unit_cost       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    line_total      DECIMAL(12,2)   AS (ROUND(quantity * unit_cost, 2)) STORED,
    added_by        INT UNSIGNED    NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT fk_materials_work_order
        FOREIGN KEY (work_order_id) REFERENCES work_orders (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_materials_added_by
        FOREIGN KEY (added_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT chk_materials_quantity  CHECK (quantity > 0),
    CONSTRAINT chk_materials_unit_cost CHECK (unit_cost >= 0)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- maintenance_history: permanent per-machine log. Costs are snapshots
-- taken when the entry is written, so history stays accurate even if the
-- work order is later edited or deleted (work_order_id then becomes NULL).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_history (
    id                  INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    machine_id          INT UNSIGNED    NOT NULL,
    work_order_id       INT UNSIGNED    NULL,
    maintenance_type    ENUM('Preventive', 'Corrective', 'Breakdown', 'Inspection',
                             'Calibration', 'Installation', 'Other') NOT NULL,
    maintenance_date    DATE            NOT NULL,
    performed_by        INT UNSIGNED    NULL,
    work_performed      TEXT            NOT NULL,
    downtime_hours      DECIMAL(8,2)    NOT NULL DEFAULT 0.00,
    labour_cost         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    material_cost       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    total_cost          DECIMAL(12,2)   AS (labour_cost + material_cost) STORED,
    remarks             TEXT            NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT uq_history_work_order UNIQUE (work_order_id),  -- one entry per work order
    INDEX idx_history_machine_date (machine_id, maintenance_date),

    CONSTRAINT fk_history_machine
        FOREIGN KEY (machine_id) REFERENCES machines (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_history_work_order
        FOREIGN KEY (work_order_id) REFERENCES work_orders (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_history_performed_by
        FOREIGN KEY (performed_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT chk_history_downtime CHECK (downtime_hours >= 0),
    CONSTRAINT chk_history_costs    CHECK (labour_cost >= 0 AND material_cost >= 0)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- audit_log: append-only record of who did what, when, to which record.
-- actor_name / actor_role / entity_label are snapshots so entries stay
-- readable after the user or record changes. (Added in migration 002.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    actor_id        INT UNSIGNED    NULL,
    actor_name      VARCHAR(100)    NOT NULL,
    actor_role      VARCHAR(20)     NOT NULL,
    action          VARCHAR(40)     NOT NULL,
    entity_type     VARCHAR(30)     NOT NULL,
    entity_id       INT UNSIGNED    NULL,
    entity_label    VARCHAR(150)    NULL,
    summary         VARCHAR(255)    NOT NULL,
    details         JSON            NULL,
    ip_address      VARCHAR(45)     NULL,

    PRIMARY KEY (id),
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_actor (actor_id, created_at),
    INDEX idx_audit_action (action, created_at),
    INDEX idx_audit_entity (entity_type, entity_id),

    CONSTRAINT fk_audit_actor
        FOREIGN KEY (actor_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- login_attempts: failed sign-ins, used to throttle password guessing
-- (LOGIN_MAX_FAILURES per username+IP within LOGIN_LOCKOUT_SECONDS, in
-- backend/routes/auth.py). Persisted here rather than kept in memory so the
-- limit holds across every app process/worker and survives restarts.
-- Rows are pruned as new failures are recorded; a successful login clears
-- the matching rows. (Added in migration 003.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username        VARCHAR(120)    NOT NULL,
    ip_address      VARCHAR(45)     NOT NULL,
    attempted_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),
    INDEX idx_login_attempts_lookup (username, ip_address, attempted_at)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- technician_ratings + material_photos (added in migration 004).
-- ---------------------------------------------------------------------
-- One optional 1-5 star rating per work order, given by a supervisor/admin
-- when the work is verified or closed. Kept (unlinked) if the work order is
-- later deleted, so a technician's average doesn't silently change.
CREATE TABLE IF NOT EXISTS technician_ratings (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    work_order_id   INT UNSIGNED    NULL,
    technician_id   INT UNSIGNED    NOT NULL,
    rated_by        INT UNSIGNED    NOT NULL,
    stars           TINYINT UNSIGNED NOT NULL,
    comment         VARCHAR(500)    NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT uq_rating_work_order UNIQUE (work_order_id),
    INDEX idx_rating_technician (technician_id, created_at),

    CONSTRAINT fk_rating_work_order
        FOREIGN KEY (work_order_id) REFERENCES work_orders (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_rating_technician
        FOREIGN KEY (technician_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_rating_rated_by
        FOREIGN KEY (rated_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT chk_rating_stars CHECK (stars BETWEEN 1 AND 5)
) ENGINE = InnoDB;

-- At most one photo per logged material. The image itself lives in
-- Cloudinary; this row holds its address, the experimental AI check result
-- (a hint only) and the supervisor's own review decision.
CREATE TABLE IF NOT EXISTS material_photos (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    material_id     INT UNSIGNED    NOT NULL,
    public_id       VARCHAR(255)    NOT NULL,       -- Cloudinary asset id
    url             VARCHAR(500)    NOT NULL,
    width           INT UNSIGNED    NULL,
    height          INT UNSIGNED    NULL,
    bytes           INT UNSIGNED    NULL,
    uploaded_by     INT UNSIGNED    NULL,
    uploaded_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    ai_status       ENUM('pending', 'consistent', 'unclear', 'mismatch', 'unavailable', 'error')
                                    NOT NULL DEFAULT 'pending',
    ai_note         VARCHAR(500)    NULL,           -- plain-language hint shown to supervisors
    ai_detail       VARCHAR(500)    NULL,           -- what the model said it saw
    ai_checked_for  VARCHAR(120)    NULL,           -- material name the check was run against
    ai_model        VARCHAR(60)     NULL,
    ai_checked_at   DATETIME        NULL,

    review_status   ENUM('Approved', 'Rejected') NULL,
    review_note     VARCHAR(255)    NULL,
    reviewed_by     INT UNSIGNED    NULL,
    reviewed_at     DATETIME        NULL,

    PRIMARY KEY (id),
    CONSTRAINT uq_photo_material UNIQUE (material_id),

    CONSTRAINT fk_photo_material
        FOREIGN KEY (material_id) REFERENCES materials (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_photo_uploaded_by
        FOREIGN KEY (uploaded_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_photo_reviewed_by
        FOREIGN KEY (reviewed_by) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_work_orders_before_insert;
DROP TRIGGER IF EXISTS trg_work_orders_before_update;
DROP TRIGGER IF EXISTS trg_materials_after_insert;
DROP TRIGGER IF EXISTS trg_materials_after_update;
DROP TRIGGER IF EXISTS trg_materials_after_delete;

DELIMITER $$

-- Any status past Pending must have an assigned technician.
-- (Replaces a CHECK constraint, which MySQL rejects on assigned_technician_id
-- because that column's foreign key has a referential action.)
CREATE TRIGGER trg_work_orders_before_insert
BEFORE INSERT ON work_orders
FOR EACH ROW
BEGIN
    IF NEW.status <> 'Pending' AND NEW.assigned_technician_id IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'A work order must have an assigned technician unless its status is Pending.';
    END IF;
END$$

CREATE TRIGGER trg_work_orders_before_update
BEFORE UPDATE ON work_orders
FOR EACH ROW
BEGIN
    IF NEW.status <> 'Pending' AND NEW.assigned_technician_id IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'A work order must have an assigned technician unless its status is Pending.';
    END IF;
END$$

-- Keep work_orders.material_cost equal to the sum of its materials.
-- (Generated columns cannot reference other tables.)

CREATE TRIGGER trg_materials_after_insert
AFTER INSERT ON materials
FOR EACH ROW
BEGIN
    UPDATE work_orders
       SET material_cost = (SELECT COALESCE(SUM(line_total), 0)
                              FROM materials WHERE work_order_id = NEW.work_order_id)
     WHERE id = NEW.work_order_id;
END$$

CREATE TRIGGER trg_materials_after_update
AFTER UPDATE ON materials
FOR EACH ROW
BEGIN
    UPDATE work_orders
       SET material_cost = (SELECT COALESCE(SUM(line_total), 0)
                              FROM materials WHERE work_order_id = NEW.work_order_id)
     WHERE id = NEW.work_order_id;

    -- Material moved to a different work order: recalculate the old one too.
    IF OLD.work_order_id <> NEW.work_order_id THEN
        UPDATE work_orders
           SET material_cost = (SELECT COALESCE(SUM(line_total), 0)
                                  FROM materials WHERE work_order_id = OLD.work_order_id)
         WHERE id = OLD.work_order_id;
    END IF;
END$$

CREATE TRIGGER trg_materials_after_delete
AFTER DELETE ON materials
FOR EACH ROW
BEGIN
    UPDATE work_orders
       SET material_cost = (SELECT COALESCE(SUM(line_total), 0)
                              FROM materials WHERE work_order_id = OLD.work_order_id)
     WHERE id = OLD.work_order_id;
END$$

DELIMITER ;
