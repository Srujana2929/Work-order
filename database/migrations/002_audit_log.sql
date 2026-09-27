-- =====================================================================
-- Migration 002: audit_log table
-- Run once as root against an existing database:
--   Get-Content database\migrations\002_audit_log.sql -Raw | & $mysql -u root -p
-- Safe to re-run. (New installs get this table from schema.sql.)
-- =====================================================================

USE work_order_db;

-- Append-only record of who did what, when, to which record.
-- actor_name / actor_role / entity_label are snapshots taken at the time,
-- so entries stay readable even if the user or record changes later.
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    actor_id        INT UNSIGNED    NULL,
    actor_name      VARCHAR(100)    NOT NULL,
    actor_role      VARCHAR(20)     NOT NULL,
    action          VARCHAR(40)     NOT NULL,       -- e.g. work_order.status_changed
    entity_type     VARCHAR(30)     NOT NULL,       -- work_order | material | user | machine | maintenance_history
    entity_id       INT UNSIGNED    NULL,
    entity_label    VARCHAR(150)    NULL,           -- e.g. WO-00012, tech2, CNC-001
    summary         VARCHAR(255)    NOT NULL,       -- human-readable sentence
    details         JSON            NULL,           -- before/after values etc.
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
