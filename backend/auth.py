import json
import os
import time
import uuid
import bcrypt
import jwt
from fastapi import Request, HTTPException

DATA_DIR = os.environ.get("DATA_DIR", "/data")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGO = "HS256"
JWT_TTL = 60 * 60 * 24 * 7  # 7 days

ROLES = ["user", "editor", "admin", "superadmin"]
ALLOWED_DOMAIN = os.environ.get("ALLOWED_EMAIL_DOMAIN", "synapse6.ai")


def _load_users() -> dict:
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE) as f:
        return json.load(f)


def _save_users(users: dict):
    os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def _strip_password(u: dict) -> dict:
    return {k: v for k, v in u.items() if k != "password"}


def get_all_users(include_superadmin: bool = False) -> list:
    users = _load_users()
    return [
        _strip_password(u)
        for u in users.values()
        if include_superadmin or u.get("role") != "superadmin"
    ]


def create_user(email: str, password: str, display_name: str = "") -> dict:
    # Enforce email domain
    email = email.strip().lower()
    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(400, f"Registration requires a @{ALLOWED_DOMAIN} email address")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "Invalid email address")

    users = _load_users()
    if email in users:
        raise HTTPException(400, "An account with this email already exists")

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user = {
        "id": str(uuid.uuid4()),
        "username": email,
        "display_name": display_name or email,
        "password": hashed,
        "role": "user",
        "approved": False,
        "created_at": int(time.time()),
    }
    # First user ever becomes superadmin and is auto-approved
    if not users:
        user["role"] = "superadmin"
        user["approved"] = True

    users[email] = user
    _save_users(users)
    return _strip_password(user)


def approve_user(username: str, role: str = "user", caller_role: str = "admin"):
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    target_role = users[username].get("role")
    if target_role == "superadmin" and caller_role != "superadmin":
        raise HTTPException(403, "Cannot modify a superadmin account")
    users[username]["approved"] = True
    users[username]["role"] = role
    _save_users(users)


def deny_user(username: str, caller_role: str = "admin"):
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    if users[username].get("role") == "superadmin" and caller_role != "superadmin":
        raise HTTPException(403, "Cannot remove a superadmin account")
    del users[username]
    _save_users(users)


def update_user_role(username: str, role: str, caller_role: str = "admin"):
    if role not in ROLES:
        raise HTTPException(400, "Invalid role")
    if role == "superadmin" and caller_role != "superadmin":
        raise HTTPException(403, "Only a superadmin can grant superadmin role")
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    if users[username].get("role") == "superadmin" and caller_role != "superadmin":
        raise HTTPException(403, "Cannot modify a superadmin account")
    users[username]["role"] = role
    _save_users(users)


def change_password(username: str, new_password: str, caller_role: str = "admin"):
    if len(new_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    if users[username].get("role") == "superadmin" and caller_role != "superadmin":
        raise HTTPException(403, "Cannot modify a superadmin account")
    users[username]["password"] = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    _save_users(users)


def login(username: str, password: str) -> str:
    username = username.strip().lower()
    users = _load_users()
    user = users.get(username)
    if not user:
        raise HTTPException(401, "Invalid credentials")
    if not bcrypt.checkpw(password.encode(), user["password"].encode()):
        raise HTTPException(401, "Invalid credentials")
    if not user.get("approved"):
        raise HTTPException(403, "Account pending approval")
    payload = {
        "sub": username,
        "role": user["role"],
        "display_name": user["display_name"],
        "exp": int(time.time()) + JWT_TTL,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def get_current_user(request: Request) -> dict:
    token = request.cookies.get("session")
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid session")
    # Verify user still exists and is still approved
    users = _load_users()
    user = users.get(payload["sub"])
    if not user or not user.get("approved"):
        raise HTTPException(401, "Account not found or no longer active")
    return payload


def require_role(min_role: str):
    """Returns a dependency that enforces a minimum role."""
    min_idx = ROLES.index(min_role)

    def _check(request: Request) -> dict:
        user = get_current_user(request)
        if ROLES.index(user["role"]) < min_idx:
            raise HTTPException(403, "Insufficient permissions")
        return user

    return _check
