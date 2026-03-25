from fastapi import APIRouter, Request, Response, Depends, HTTPException
from pydantic import BaseModel
from auth import (
    create_user, create_user_admin, login, get_current_user, require_role,
    approve_user, deny_user, update_user_role, get_all_users,
    change_password, change_own_password, change_display_name, ALLOWED_DOMAIN
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


class MeProfileBody(BaseModel):
    display_name: str


class MePasswordBody(BaseModel):
    old_password: str
    new_password: str


class AdminCreateBody(BaseModel):
    username: str
    password: str
    display_name: str = ""
    role: str = "user"


# ── Public ────────────────────────────────────────────────────────────────

@router.get("/domain")
def get_allowed_domain():
    """Tell the frontend what email domain is required."""
    return {"domain": ALLOWED_DOMAIN}


@router.post("/register", include_in_schema=False)
def register():
    raise HTTPException(403, "Self-registration is disabled. Contact an administrator.")


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


@router.patch("/me")
def update_me(body: MeProfileBody, user=Depends(get_current_user)):
    change_display_name(user["sub"], body.display_name)
    return {"ok": True}


@router.patch("/me/password")
def change_me_password(body: MePasswordBody, user=Depends(get_current_user)):
    change_own_password(user["sub"], body.old_password, body.new_password)
    return {"ok": True}


# ── Admin (excludes superadmins from results) ─────────────────────────────

@router.post("/users/create", dependencies=[Depends(require_role("admin"))])
def admin_create_user(body: AdminCreateBody, caller=Depends(require_role("admin"))):
    user = create_user_admin(body.username, body.password, body.display_name, body.role, caller["role"])
    return {"ok": True, "user": user}


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


@router.patch("/users/{username}/display_name", dependencies=[Depends(require_role("admin"))])
def set_display_name(username: str, body: MeProfileBody):
    change_display_name(username, body.display_name)
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

@router.post("/superadmin/users/create", dependencies=[Depends(require_role("superadmin"))])
def superadmin_create_user(body: AdminCreateBody):
    user = create_user_admin(body.username, body.password, body.display_name, body.role, "superadmin")
    return {"ok": True, "user": user}


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


@router.patch("/superadmin/users/{username}/display_name", dependencies=[Depends(require_role("superadmin"))])
def superadmin_set_display_name(username: str, body: MeProfileBody):
    change_display_name(username, body.display_name)
    return {"ok": True}


@router.patch("/superadmin/users/{username}/role", dependencies=[Depends(require_role("superadmin"))])
def superadmin_set_role(username: str, body: RoleBody):
    update_user_role(username, body.role, caller_role="superadmin")
    return {"ok": True}


@router.patch("/superadmin/users/{username}/password", dependencies=[Depends(require_role("superadmin"))])
def superadmin_set_password(username: str, body: PasswordBody):
    change_password(username, body.password, caller_role="superadmin")
    return {"ok": True}
