"""
PathoDB API — Auth Utilities
JWT creation/verification and password hashing.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status, Security
from fastapi.security import OAuth2PasswordBearer, APIKeyHeader
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import User

settings    = get_settings()
oauth2      = OAuth2PasswordBearer(tokenUrl="/auth/login")
api_key_hdr = APIKeyHeader(name="X-API-Key", auto_error=False)

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

def create_access_token(user_id: int, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=settings.jwt_expiry_hours)
    return jwt.encode(
        {"sub": str(user_id), "role": role, "type": "access", "exp": expire},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )

def create_refresh_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_expiry_days)
    return jwt.encode(
        {"sub": str(user_id), "type": "refresh", "exp": expire},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

def get_current_user(
    token: str = Depends(oauth2),
    db: Session = Depends(get_db),
) -> User:
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    user = db.get(User, int(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user

def get_current_active_user(user: User = Depends(get_current_user)) -> User:
    return user

def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

def get_user_or_scanner(
    token: Optional[str] = Depends(oauth2),
    api_key: Optional[str] = Security(api_key_hdr),
    db: Session = Depends(get_db),
) -> Optional[User]:
    if api_key and api_key == settings.scanner_api_key:
        return None
    if token:
        return get_current_user(token, db)
    raise HTTPException(status_code=401, detail="Authentication required")
