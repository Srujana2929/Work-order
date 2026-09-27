-- Creates a least-privilege MySQL account for the Flask app.
-- 1. Replace CHANGE_ME_STRONG_PASSWORD below with a real password.
-- 2. Run as root AFTER schema.sql:
--      mysql -u root -p < database/create_app_user.sql
-- 3. Put the same username/password in backend/.env.

CREATE USER IF NOT EXISTS 'wo_app'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

-- Data access only: the app cannot drop tables or change the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_order_db.* TO 'wo_app'@'localhost';

FLUSH PRIVILEGES;
