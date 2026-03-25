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


def _load_users() -> dict:
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE) as f:
        return json.load(f)


def _save_users(users: dict):
    os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def get_all_users() -> list:
    users = _load_users()
    return [
        {k: v for k, v in u.items() if k != "password"}
        for u in users.values()
    ]


def create_user(username: str, password: str, display_name: str = "") -> dict:
    users = _load_users()
    if username in users:
        raise HTTPException(400, "Username already exists")
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "display_name": display_name or username,
        "password": hashed,
        "role": "user",
        "approved": False,
        "created_at": int(time.time()),
    }
    # First user ever becomes superadmin and is auto-approved
    if not users:
        user["role"] = "superadmin"
        user["approved"] = True
    users[username] = user
    _save_users(users)
    return {k: v for k, v in user.items() if k != "password"}


def approve_user(username: str, role: str = "user"):
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    users[username]["approved"] = True
    users[username]["role"] = role
    _save_users(users)


def deny_user(username: str):
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    del users[username]
    _save_users(users)


def update_user_role(username: str, role: str):
    if role not in ROLES:
        raise HTTPException(400, "Invalid role")
    users = _load_users()
    if username not in users:
        raise HTTPException(404, "User not found")
    users[username]["role"] = role
    _save_users(users)


def login(username: str, password: str) -> str:
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
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid session")


def require_role(min_role: str):
    """Returns a dependency that enforces a minimum role."""
    min_idx = ROLES.index(min_role)

    def _check(request: Request) -> dict:
        user = get_current_user(request)
        if ROLES.index(user["role"]) < min_idx:
            raise HTTPException(403, "Insufficient permissions")
        return user

    return _check
