import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional

import boto3
import jwt
from botocore.config import Config
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from passlib.context import CryptContext
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from .db import get_db
from .models import capture_sessions, session_assets, session_reviews, users

APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:3000")
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://minio:9000")
S3_BUCKET = os.getenv("S3_BUCKET", "carsoo-capture")
S3_ACCESS_KEY = os.getenv("S3_ACCESS_KEY", "minioadmin")
S3_SECRET_KEY = os.getenv("S3_SECRET_KEY", "minioadmin")
S3_REGION = os.getenv("S3_REGION", "us-east-1")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret")
JWT_ISSUER = os.getenv("JWT_ISSUER", "carsoo-capture")
ADMIN_SEED_EMAIL = os.getenv("ADMIN_SEED_EMAIL", "admin@carsoo.ai")
ADMIN_SEED_PASSWORD = os.getenv("ADMIN_SEED_PASSWORD", "admin123")
SESSION_TTL_DAYS = int(os.getenv("SESSION_TTL_DAYS", "7"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

s3_client = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    aws_access_key_id=S3_ACCESS_KEY,
    aws_secret_access_key=S3_SECRET_KEY,
    region_name=S3_REGION,
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

app = FastAPI(title="Carsoo Seller Remote Capture API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


CORE_REQUIRED_STEP_KEYS = [
    "odometer_closeup",
    "vin_windshield",
    "plate_front_or_rear",
    "keys_photo",
    "ext_front",
    "ext_rear",
    "ext_left_side",
    "ext_right_side",
    "int_dashboard_wide",
    "engine_bay_wide",
]


class SessionCreate(BaseModel):
    seller_name: Optional[str] = None
    seller_phone: Optional[str] = None
    seller_email: Optional[str] = None
    listing_id: Optional[str] = None
    vin: Optional[str] = None
    plate: Optional[str] = None
    province: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_year: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class ReviewDecision(BaseModel):
    step_key: str
    decision: str
    comment: Optional[str] = None


class SubmitRequest(BaseModel):
    agree_documents_redaction: bool = False


class AdminSessionList(BaseModel):
    id: int
    status: str
    vin: Optional[str]
    plate: Optional[str]
    created_at: datetime
    missing_required: int


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def require_admin(authorization: str = Header(...)) -> Dict[str, Any]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.replace("Bearer ", "")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], issuer=JWT_ISSUER)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    return payload


@app.on_event("startup")
def startup_tasks():
    try:
        s3_client.head_bucket(Bucket=S3_BUCKET)
    except Exception:
        s3_client.create_bucket(Bucket=S3_BUCKET)


STEPS = [
    {"stepKey": "odometer_closeup", "title": "Odometer close-up", "description": "Capture the illuminated odometer clearly.", "example": "/examples/odometer.jpg", "group": "Vehicle Identity"},
    {"stepKey": "vin_windshield", "title": "VIN windshield", "description": "Photograph the VIN plate through the windshield.", "example": "/examples/vin_windshield.jpg", "group": "Vehicle Identity"},
    {"stepKey": "vin_door_jamb", "title": "VIN door jamb", "description": "Photograph the VIN label on the door jamb.", "example": "/examples/vin_door.jpg", "group": "Vehicle Identity"},
    {"stepKey": "plate_front_or_rear", "title": "License plate", "description": "Photograph the rear license plate clearly.", "example": "/examples/plate.jpg", "group": "Vehicle Identity"},
    {"stepKey": "keys_photo", "title": "Keys", "description": "Photograph the key fob and spare keys if any.", "example": "/examples/keys.jpg", "group": "Vehicle Identity"},
    {"stepKey": "ext_front", "title": "Front", "description": "Front view of the vehicle.", "example": "/examples/ext_front.jpg", "group": "Exterior"},
    {"stepKey": "ext_rear", "title": "Rear", "description": "Rear view of the vehicle.", "example": "/examples/ext_rear.jpg", "group": "Exterior"},
    {"stepKey": "ext_left_side", "title": "Left side", "description": "Driver-side profile.", "example": "/examples/ext_left.jpg", "group": "Exterior"},
    {"stepKey": "ext_right_side", "title": "Right side", "description": "Passenger-side profile.", "example": "/examples/ext_right.jpg", "group": "Exterior"},
    {"stepKey": "int_dashboard_wide", "title": "Dashboard wide", "description": "Dashboard, steering wheel, and gauges.", "example": "/examples/int_dashboard.jpg", "group": "Interior"},
    {"stepKey": "engine_bay_wide", "title": "Engine bay", "description": "Wide shot of the engine bay.", "example": "/examples/engine.jpg", "group": "Mechanical"},
    {"stepKey": "int_center_console", "title": "Center console", "description": "Center console and shifter.", "example": "/examples/int_console.jpg", "group": "Interior"},
    {"stepKey": "int_front_seats", "title": "Front seats", "description": "Front seats and cabin.", "example": "/examples/int_front_seats.jpg", "group": "Interior"},
    {"stepKey": "int_rear_seats", "title": "Rear seats", "description": "Rear seating area.", "example": "/examples/int_rear_seats.jpg", "group": "Interior"},
    {"stepKey": "ownership_front", "title": "Ownership front", "description": "Redact address/ID numbers before upload.", "example": "/examples/ownership_front.jpg", "group": "Documents"},
]


def normalized_steps() -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for step in STEPS:
        step_key = step["stepKey"]
        normalized.append(
            {
                **step,
                "required": step_key in CORE_REQUIRED_STEP_KEYS,
                "minCount": 1,
                "mode": "photo",
            }
        )
    return normalized


def get_step_map() -> Dict[str, Dict[str, Any]]:
    return {step["stepKey"]: step for step in normalized_steps()}


@app.get("/api/steps")
def get_steps():
    return normalized_steps()


@app.post("/api/admin/seed")
def seed_admin(db: Session = Depends(get_db)):
    existing = db.execute(select(users).where(users.c.email == ADMIN_SEED_EMAIL)).first()
    if existing:
        return {"status": "exists"}
    password_hash = pwd_context.hash(ADMIN_SEED_PASSWORD)
    db.execute(insert(users).values(email=ADMIN_SEED_EMAIL, password_hash=password_hash, role="admin"))
    db.commit()
    return {"status": "created", "email": ADMIN_SEED_EMAIL}


@app.post("/api/admin/login")
def admin_login(payload: LoginRequest, db: Session = Depends(get_db)):
    row = db.execute(select(users).where(users.c.email == payload.email)).first()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user = row._mapping
    if not pwd_context.verify(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = jwt.encode({"sub": str(user["id"]), "email": user["email"], "role": user["role"], "iss": JWT_ISSUER}, JWT_SECRET, algorithm="HS256")
    return {"token": token}


@app.post("/api/admin/sessions", response_model=Dict[str, Any])
def create_session(payload: SessionCreate, admin=Depends(require_admin), db: Session = Depends(get_db)):
    token = secrets.token_urlsafe(16)
    token_hash = hash_token(token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    result = db.execute(
        insert(capture_sessions)
        .values(
            token_hash=token_hash,
            status="draft",
            expires_at=expires_at,
            seller_name=payload.seller_name,
            seller_phone=payload.seller_phone,
            seller_email=payload.seller_email,
            listing_id=payload.listing_id,
            vin=payload.vin,
            plate=payload.plate,
            province=payload.province,
            vehicle_make=payload.vehicle_make,
            vehicle_model=payload.vehicle_model,
            vehicle_year=payload.vehicle_year,
        )
        .returning(capture_sessions.c.id)
    )
    session_id = result.scalar_one()
    db.commit()

    notifications: Dict[str, Any] = {}
    if payload.seller_phone:
        notifications["sms"] = {
            "to": payload.seller_phone,
            "message": f"Please capture your vehicle photos: {APP_BASE_URL}/seller/{token}",
        }
    if payload.seller_email:
        notifications["email"] = {
            "to": payload.seller_email,
            "subject": "Your vehicle photo capture link",
            "body": f"Open this secure link to upload photos: {APP_BASE_URL}/seller/{token}",
        }

    return {
        "id": session_id,
        "token": token,
        "link": f"{APP_BASE_URL}/seller/{token}",
        "expires_at": expires_at,
        "notifications": notifications,
    }


@app.get("/api/admin/sessions", response_model=List[AdminSessionList])
def list_sessions(admin=Depends(require_admin), db: Session = Depends(get_db)):
    sessions = db.execute(select(capture_sessions)).fetchall()
    return [
        AdminSessionList(
            id=row._mapping["id"],
            status=row._mapping["status"],
            vin=row._mapping["vin"],
            plate=row._mapping["plate"],
            created_at=row._mapping["created_at"],
            missing_required=count_missing_required(db, row._mapping["id"]),
        )
        for row in sessions
    ]


@app.get("/api/admin/sessions/{session_id}")
def get_session_admin(session_id: int, admin=Depends(require_admin), db: Session = Depends(get_db)):
    session_row = db.execute(select(capture_sessions).where(capture_sessions.c.id == session_id)).first()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    assets = db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()
    reviews = db.execute(select(session_reviews).where(session_reviews.c.session_id == session_id)).fetchall()
    return {
        "session": dict(session_row._mapping),
        "assets": [serialize_asset(row._mapping, preview_path=f"/api/admin/assets/{row._mapping['id']}/preview") for row in assets],
        "reviews": [dict(row._mapping) for row in reviews],
    }


@app.get("/api/admin/assets/{asset_id}/preview")
def preview_admin_asset(asset_id: int, admin=Depends(require_admin), db: Session = Depends(get_db)):
    row = db.execute(select(session_assets).where(session_assets.c.id == asset_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    asset = row._mapping
    return stream_asset_from_storage(asset)


@app.post("/api/admin/sessions/{session_id}/review")
def review_session(session_id: int, payload: List[ReviewDecision], admin=Depends(require_admin), db: Session = Depends(get_db)):
    session_row = db.execute(select(capture_sessions).where(capture_sessions.c.id == session_id)).first()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    db.execute(delete(session_reviews).where(session_reviews.c.session_id == session_id))
    for decision in payload:
        db.execute(
            insert(session_reviews).values(
                session_id=session_id,
                step_key=decision.step_key,
                decision=decision.decision,
                comment=decision.comment,
                reviewer_id=int(admin["sub"]),
            )
        )
    new_status = "retake" if any(d.decision == "retake" for d in payload) else "completed"
    db.execute(update(capture_sessions).where(capture_sessions.c.id == session_id).values(status=new_status))
    db.commit()
    return {"status": new_status}


@app.get("/api/admin/sessions/{session_id}/export")
def export_session(session_id: int, admin=Depends(require_admin), db: Session = Depends(get_db)):
    session_row = db.execute(select(capture_sessions).where(capture_sessions.c.id == session_id)).first()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    assets = db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()
    reviews = db.execute(select(session_reviews).where(session_reviews.c.session_id == session_id)).fetchall()
    assets_payload: Dict[str, List[Dict[str, Any]]] = {}
    for row in assets:
        asset = row._mapping
        assets_payload.setdefault(asset["step_key"], []).append(
            {
                "url": f"/api/admin/assets/{asset['id']}/preview",
                "width": asset["width"],
                "height": asset["height"],
                "sizeBytes": asset["size_bytes"],
            }
        )
    review_payload = {
        row._mapping["step_key"]: {
            "decision": row._mapping["decision"],
            "comment": row._mapping["comment"],
        }
        for row in reviews
    }
    session = session_row._mapping
    return {
        "sessionId": session["id"],
        "vin": session["vin"],
        "plate": session["plate"],
        "province": session["province"],
        "assets": assets_payload,
        "review": review_payload,
        "timestamps": {
            "createdAt": session["created_at"],
            "submittedAt": session["submitted_at"],
        },
    }


@app.get("/api/sessions/{token}")
def get_session(token: str, db: Session = Depends(get_db)):
    token_hash = hash_token(token)
    row = db.execute(select(capture_sessions).where(capture_sessions.c.token_hash == token_hash)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Invalid session token")
    session = row._mapping
    if session["expires_at"] and session["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Session expired")
    assets = db.execute(select(session_assets).where(session_assets.c.session_id == session["id"])).fetchall()
    reviews = db.execute(select(session_reviews).where(session_reviews.c.session_id == session["id"])).fetchall()
    return {
        "session": dict(session),
        "assets": [
            serialize_asset(
                row._mapping,
                preview_path=f"/api/sessions/{token}/assets/{row._mapping['id']}/preview",
            )
            for row in assets
        ],
        "reviews": [dict(row._mapping) for row in reviews],
        "missing_required": count_missing_required(db, session["id"]),
        "next_step_key": find_next_step_key(db, session["id"]),
    }


@app.get("/api/sessions/{token}/assets/{asset_id}/preview")
def preview_seller_asset(token: str, asset_id: int, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    row = db.execute(
        select(session_assets).where(session_assets.c.id == asset_id, session_assets.c.session_id == session_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    asset = row._mapping
    return stream_asset_from_storage(asset)


@app.post("/api/sessions/{token}/assets")
def upload_asset(
    token: str,
    step_key: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    session_id = get_session_id(db, token)
    step_map = get_step_map()
    if step_key not in step_map:
        raise HTTPException(status_code=400, detail="Invalid step")

    mime_type = file.content_type or ""
    if not mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are allowed")

    data = file.file.read()
    size_bytes = len(data)
    if size_bytes == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if size_bytes > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 10MB limit")

    try:
        image = Image.open(BytesIO(data))
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        if width < 1600 and height < 1600:
            raise HTTPException(status_code=400, detail="Image too small (min 1600px on one side)")
        output_buffer = BytesIO()
        image.save(output_buffer, format=image.format or "JPEG")
        output_buffer.seek(0)
        normalized_bytes = output_buffer.read()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    object_key = f"sessions/{session_id}/{secrets.token_hex(8)}-{file.filename or 'upload.jpg'}"
    s3_client.put_object(Bucket=S3_BUCKET, Key=object_key, Body=normalized_bytes, ContentType=mime_type)

    file_url = f"{S3_ENDPOINT}/{S3_BUCKET}/{object_key}"
    result = db.execute(
        insert(session_assets)
        .values(
            session_id=session_id,
            step_key=step_key,
            file_url=file_url,
            mime_type=mime_type,
            width=width,
            height=height,
            size_bytes=len(normalized_bytes),
        )
        .returning(session_assets.c.id)
    )
    asset_id = result.scalar_one()
    db.commit()

    row = db.execute(select(session_assets).where(session_assets.c.id == asset_id)).first()
    return serialize_asset(
        row._mapping,
        preview_path=f"/api/sessions/{token}/assets/{asset_id}/preview",
    )


@app.post("/api/sessions/{token}/submit")
def submit_session(token: str, payload: SubmitRequest, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    if payload.agree_documents_redaction is not True:
        raise HTTPException(status_code=400, detail="You must confirm document redaction before submitting")
    missing = count_missing_required(db, session_id)
    if missing > 0:
        raise HTTPException(status_code=400, detail="Required steps are missing")
    db.execute(
        update(capture_sessions)
        .where(capture_sessions.c.id == session_id)
        .values(status="submitted", submitted_at=datetime.now(timezone.utc))
    )
    db.commit()
    return {"status": "submitted"}


@app.post("/api/sessions/{token}/extend")
def extend_session(token: str, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    db.execute(update(capture_sessions).where(capture_sessions.c.id == session_id).values(expires_at=expires_at))
    db.commit()
    return {"expires_at": expires_at}


def get_session_id(db: Session, token: str) -> int:
    token_hash = hash_token(token)
    row = db.execute(select(capture_sessions).where(capture_sessions.c.token_hash == token_hash)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Invalid session token")
    session = row._mapping
    if session["expires_at"] and session["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Session expired")
    return session["id"]


def count_assets_by_step(db: Session, session_id: int) -> Dict[str, int]:
    asset_rows = db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()
    counts: Dict[str, int] = {}
    for row in asset_rows:
        key = row._mapping["step_key"]
        counts[key] = counts.get(key, 0) + 1
    return counts


def count_missing_required(db: Session, session_id: int) -> int:
    counts = count_assets_by_step(db, session_id)
    steps = normalized_steps()
    return sum(1 for step in steps if step["required"] and counts.get(step["stepKey"], 0) < step["minCount"])


def find_next_step_key(db: Session, session_id: int) -> Optional[str]:
    counts = count_assets_by_step(db, session_id)
    steps = normalized_steps()
    for step in steps:
        if step["required"] and counts.get(step["stepKey"], 0) < step["minCount"]:
            return step["stepKey"]
    for step in steps:
        if counts.get(step["stepKey"], 0) < step["minCount"]:
            return step["stepKey"]
    return None


def extract_object_key(file_url: str) -> str:
    prefix = f"{S3_ENDPOINT}/{S3_BUCKET}/"
    if not file_url.startswith(prefix):
        raise HTTPException(status_code=500, detail="Invalid storage URL")
    return file_url[len(prefix):]


def stream_asset_from_storage(asset: Dict[str, Any]) -> StreamingResponse:
    object_key = extract_object_key(asset["file_url"])
    obj = s3_client.get_object(Bucket=S3_BUCKET, Key=object_key)
    return StreamingResponse(obj["Body"], media_type=asset.get("mime_type") or "application/octet-stream")


def serialize_asset(asset: Dict[str, Any], preview_path: str) -> Dict[str, Any]:
    payload = dict(asset)
    payload["preview_url"] = preview_path
    return payload


@app.get("/api/health")
def health():
    return {"status": "ok"}
