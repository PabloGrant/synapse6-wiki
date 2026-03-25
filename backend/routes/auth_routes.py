from fastapi import APIRouter, Request, Response, Depends
from pydantic import BaseModel
from auth import (
    create_user, login, get_current_user, require_role,
    approve_user, deny_user, update_user_role, get_all_users,
    change_password, ALLOWED_DOMAIN
)

router = APIRouter(prefix="/api/auth")


class RegisterBody(BaseModel):
    username: str   # treated as email
    password: str
    display_name: str = ""


class LoginBody(BaseModel):
    username: str
    password: str


class RoleBody(BaseModel):
    role: str


class PasswordBody(BaseModel):
    password: str


# ── Public ────────────────────────────────────────────────────────────────

@router.get("/domain")
def get_allowed_domain():
    """Tell the frontend what email domain is required."""
    return {"domain": ALLOWED_DOMAIN}


@router.post("/register")
def register(body: RegisterBody):
    user = create_user(body.username, body.password, body.display_name)
    return {"ok": True, "user": user}


@router.post("/login")
def do_login(body: LoginBody, response: Response):
    token = login(body.username, body.password)
    response.set_cookie(
        "session", token,
        httponly=True, samesite="lax",
        max_age=60 * 60 * 24 * 7
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return user


# ── Admin (excludes superadmins from results) ─────────────────────────────

@router.get("/users", dependencies=[Depends(require_role("admin"))])
def list_users():
    """Returns all non-superadmin users. Superadmins are invisible here."""
    return get_all_users(include_superadmin=False)


@router.post("/users/{username}/approve", dependencies=[Depends(require_role("admin"))])
def approve(username: str, body: RoleBody, caller=Depends(require_role("admin"))):
    approve_user(username, body.role, caller_role=caller["role"])
    return {"ok": True}


@router.delete("/users/{username}", dependencies=[Depends(require_role("admin"))])
def deny(username: str, caller=Depends(require_role("admin"))):
    deny_user(username, caller_role=caller["role"])
    return {"ok": True}


@router.patch("/users/{username}/role", dependencies=[Depends(require_role("admin"))])
def set_role(username: str, body: RoleBody, caller=Depends(require_role("admin"))):
    update_user_role(username, body.role, caller_role=caller["role"])
    return {"ok": True}


@router.patch("/users/{username}/password", dependencies=[Depends(require_role("admin"))])
def set_password(username: str, body: PasswordBody, caller=Depends(require_role("admin"))):
    change_password(username, body.password, caller_role=caller["role"])
    return {"ok": True}


# ── Superadmin only ───────────────────────────────────────────────────────

@router.get("/superadmin/users", dependencies=[Depends(require_role("superadmin"))])
def list_all_users_superadmin():
    """Full user list including superadmins. Superadmin eyes only."""
    return get_all_users(include_superadmin=True)


@router.post("/superadmin/users/{username}/approve", dependencies=[Depends(require_role("superadmin"))])
def superadmin_approve(username: str, body: RoleBody):
    approve_user(username, body.role, caller_role="superadmin")
    return {"ok": True}


@router.delete("/superadmin/users/{username}", dependencies=[Depends(require_role("superadmin"))])
def superadmin_deny(username: str):
    deny_user(username, caller_role="superadmin")
    return {"ok": True}


@router.patch("/superadmin/users/{username}/role", dependencies=[Depends(require_role("superadmin"))])
def superadmin_set_role(username: str, body: RoleBody):
    update_user_role(username, body.role, caller_role="superadmin")
    return {"ok": True}


@router.patch("/superadmin/users/{username}/password", dependencies=[Depends(require_role("superadmin"))])
def superadmin_set_password(username: str, body: PasswordBody):
    change_password(username, body.password, caller_role="superadmin")
    return {"ok": True}
