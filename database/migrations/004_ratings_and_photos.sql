-- =====================================================================
-- Migration 004: technician ratings + material photos
-- Run once as root against an existing database:
--   Get-Content database\migrations\004_ratings_and_photos.sql -Raw | & $mysql -u root -p
-- Safe to re-run. (New installs get these tables from schema.sql.)
-- Until it runs, the app keeps working; ratings and photos are simply
-- unavailable (the UI says so).
-- =====================================================================

USE work_order_db;

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
