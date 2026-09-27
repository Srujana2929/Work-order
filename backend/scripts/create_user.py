"""Create a user from the command line (e.g. the first Admin).

Run from the backend folder with the venv active:
    python scripts/create_user.py --username admin --full-name "Site Admin" \
        --email admin@example.com --role Admin

You'll be prompted for the password. --password is available for scripting,
but it ends up in your shell history.
"""
import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import create_app  # noqa: E402
from errors import APIError  # noqa: E402
from extensions import db  # noqa: E402
from models import User  # noqa: E402
from models.enums import ROLES  # noqa: E402
from validation import (  # noqa: E402
    clean_str, validate_email, validate_password, validate_role, validate_username,
)


def main():
    parser = argparse.ArgumentParser(description="Create a Work Order system user.")
    parser.add_argument("--username", required=True)
    parser.add_argument("--full-name", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--role", required=True, choices=ROLES)
    parser.add_argument("--department")
    parser.add_argument("--phone")
    parser.add_argument("--password", help="omit to be prompted (recommended)")
    args = parser.parse_args()

    password = args.password
    if password is None:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Confirm password: ") != password:
            print("Passwords do not match.")
            return 1

    app = create_app()
    with app.app_context():
        try:
            username = validate_username(args.username)
            email = validate_email(args.email)
            user = User(
                full_name=clean_str(args.full_name, "full_name", 100, required=True),
                username=username,
                email=email,
                role=validate_role(args.role),
                department=clean_str(args.department, "department", 100),
                phone=clean_str(args.phone, "phone", 20),
            )
            user.set_password(validate_password(password))
        except APIError as exc:
            print(f"Invalid input: {exc.message}")
            return 1

        if User.query.filter((User.username == username) | (User.email == email)).first():
            print(f"A user with username '{username}' or email '{email}' already exists.")
            return 1

        db.session.add(user)
        db.session.commit()
        print(f"Created {user.role} '{user.username}' (id={user.id}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
