"""Application configuration, read from environment variables.

Values come from the real environment or from backend/.env (loaded below).
Copy .env.example to .env and fill it in; never commit .env.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.engine import URL

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _require(name):
    value = os.getenv(name)
    if value is None or value.strip() == "":
        raise RuntimeError(
            f"Missing required environment variable '{name}'. "
            f"Set it in backend/.env (see backend/.env.example)."
        )
    return value


def build_database_uri():
    # URL.create escapes special characters in the password (@, :, / ...).
    return URL.create(
        drivername="mysql+pymysql",
        username=_require("DB_USER"),
        password=_require("DB_PASSWORD"),
        host=_require("DB_HOST"),
        port=int(_require("DB_PORT")),
        database=_require("DB_NAME"),
        query={"charset": "utf8mb4"},
    ).render_as_string(hide_password=False)


class Config:
    # Signs the JWT access tokens. Use a long random value (32+ characters).
    # No fallback: DevelopmentConfig below opts into a labelled insecure
    # default explicitly; every other config must set this in the environment.
    SECRET_KEY = os.getenv("SECRET_KEY")
    JWT_EXPIRES_MINUTES = int(os.getenv("JWT_EXPIRES_MINUTES", "480"))  # one 8-hour shift
    # Send the login cookie over HTTPS only. Must be true in production.
    AUTH_COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "true").lower() == "true"
    SQLALCHEMY_DATABASE_URI = build_database_uri()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,   # drop dead connections before using them
        "pool_recycle": 280,     # stay under MySQL's wait_timeout
    }
    JSON_SORT_KEYS = False
    MAX_CONTENT_LENGTH = 1024 * 1024        # 1 MB request bodies; larger -> 413
    # Login throttling: this many failed attempts per username+IP within the window -> 429.
    LOGIN_MAX_FAILURES = int(os.getenv("LOGIN_MAX_FAILURES", "5"))
    LOGIN_LOCKOUT_SECONDS = int(os.getenv("LOGIN_LOCKOUT_SECONDS", "300"))
    # Debug mode (interactive debugger + auto-reload) is OFF unless explicitly
    # requested - never turned on implicitly by FLASK_ENV.
    DEBUG = os.getenv("FLASK_DEBUG", "false").lower() == "true"


class DevelopmentConfig(Config):
    # The only place a non-random SECRET_KEY is tolerated: local development
    # only reaches this class via an explicit FLASK_ENV=development.
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-insecure-key-change-me-0123456789")
    AUTH_COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "false").lower() == "true"


class ProductionConfig(Config):
    pass


_CONFIGS = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
}


def get_config():
    # Unset or misspelled FLASK_ENV must fail safe into the hardened config,
    # not silently fall back to development settings (dev's insecure default
    # SECRET_KEY, cookies without Secure, etc.) - only the exact value
    # "development" opts out of that.
    env = os.getenv("FLASK_ENV", "production").lower()
    config = _CONFIGS.get(env, ProductionConfig)
    if not config.SECRET_KEY:
        raise RuntimeError(
            f"SECRET_KEY must be set when FLASK_ENV={env!r}. "
            f"Set it in backend/.env (see backend/.env.example)."
        )
    return config
