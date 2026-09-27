-- =====================================================================
-- Migration 003: login_attempts table
-- Run once as root against an existing database:
--   Get-Content database\migrations\003_login_attempts.sql -Raw | & $mysql -u root -p
-- Safe to re-run. (New installs get this table from schema.sql.)
-- =====================================================================

USE work_order_db;

-- Failed sign-ins, used to throttle password guessing (LOGIN_MAX_FAILURES
-- per username+IP within LOGIN_LOCKOUT_SECONDS). Persisted here instead of
-- kept in memory so the limit holds across every app process/worker and
-- survives restarts.
CREATE TABLE IF NOT EXISTS login_attempts (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username        VARCHAR(120)    NOT NULL,
    ip_address      VARCHAR(45)     NOT NULL,
    attempted_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (id),
    INDEX idx_login_attempts_lookup (username, ip_address, attempted_at)
) ENGINE = InnoDB;
