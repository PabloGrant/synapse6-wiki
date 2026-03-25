from fastapi import APIRouter, Request, Response, Depends
from pydantic import BaseModel
from auth import (
    create_user, login, get_current_user, require_role,
    approve_user, deny_user, update_user_role, get_all_users
)

router = APIRouter(prefix="/api/auth")


class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: str = ""


class LoginBody(BaseModel):
    username: str
    password: str


class RoleBody(BaseModel):
    role: str


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


@router.get("/users", dependencies=[Depends(require_role("admin"))])
def list_users():
    return get_all_users()


@router.post("/users/{username}/approve", dependencies=[Depends(require_role("admin"))])
def approve(username: str, body: RoleBody):
    approve_user(username, body.role)
    return {"ok": True}


@router.delete("/users/{username}", dependencies=[Depends(require_role("admin"))])
def deny(username: str):
    deny_user(username)
    return {"ok": True}


@router.patch("/users/{username}/role", dependencies=[Depends(require_role("admin"))])
def set_role(username: str, body: RoleBody):
    update_user_role(username, body.role)
    return {"ok": True}
