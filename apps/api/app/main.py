import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional, Set

import boto3
import jwt
from botocore.config import Config
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
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
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
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


class SessionCreate(BaseModel):
    seller_name: Optional[str] = None
    seller_phone: Optional[str] = None
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


STEP_GROUPS = [
    {
        "group": "Vehicle Identity",
        "steps": [
            {"stepKey": "odometer_closeup", "title": "Odometer close-up", "description": "Capture the illuminated odometer clearly.", "example": "/examples/odometer.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "vin_windshield", "title": "VIN windshield", "description": "Photograph the VIN plate through the windshield.", "example": "/examples/vin_windshield.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "vin_door_jamb", "title": "VIN door jamb", "description": "Photograph the VIN label on the door jamb.", "example": "/examples/vin_door.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "plate_front_or_rear", "title": "License plate", "description": "Photograph the rear license plate clearly.", "example": "/examples/plate.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "keys_photo", "title": "Keys", "description": "Photograph the key fob and spare keys if any.", "example": "/examples/keys.jpg", "required": True, "minCount": 1, "mode": "photo"},
        ],
    },
    {
        "group": "Exterior",
        "steps": [
            {"stepKey": "ext_front", "title": "Front", "description": "Front view of the vehicle.", "example": "/examples/ext_front.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_front_left_45", "title": "Front left 45°", "description": "Front-left 45 degree angle.", "example": "/examples/ext_front_left.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_front_right_45", "title": "Front right 45°", "description": "Front-right 45 degree angle.", "example": "/examples/ext_front_right.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_rear", "title": "Rear", "description": "Rear view of the vehicle.", "example": "/examples/ext_rear.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_rear_left_45", "title": "Rear left 45°", "description": "Rear-left 45 degree angle.", "example": "/examples/ext_rear_left.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_rear_right_45", "title": "Rear right 45°", "description": "Rear-right 45 degree angle.", "example": "/examples/ext_rear_right.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_left_side", "title": "Left side", "description": "Driver-side profile.", "example": "/examples/ext_left.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_right_side", "title": "Right side", "description": "Passenger-side profile.", "example": "/examples/ext_right.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_roof_optional", "title": "Roof (optional)", "description": "Roof condition if accessible.", "example": "/examples/ext_roof.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ext_undercarriage_optional", "title": "Undercarriage (optional)", "description": "Undercarriage if possible.", "example": "/examples/ext_undercarriage.jpg", "required": False, "minCount": 1, "mode": "photo"},
        ],
    },
    {
        "group": "Interior",
        "steps": [
            {"stepKey": "int_dashboard_wide", "title": "Dashboard wide", "description": "Dashboard, steering wheel, and gauges.", "example": "/examples/int_dashboard.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_center_console", "title": "Center console", "description": "Center console and shifter.", "example": "/examples/int_console.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_infotainment_on", "title": "Infotainment on", "description": "Power on the infotainment screen.", "example": "/examples/int_infotainment.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_front_seats", "title": "Front seats", "description": "Front seats and cabin.", "example": "/examples/int_front_seats.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_rear_seats", "title": "Rear seats", "description": "Rear seating area.", "example": "/examples/int_rear_seats.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_driver_door_panel", "title": "Driver door panel", "description": "Driver door panel and controls.", "example": "/examples/int_door.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_headliner_sunroof_optional", "title": "Headliner / Sunroof (optional)", "description": "Headliner or sunroof condition.", "example": "/examples/int_headliner.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_trunk_open", "title": "Trunk open", "description": "Open trunk view.", "example": "/examples/int_trunk.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "int_trunk_floor_spare_optional", "title": "Trunk floor/spare (optional)", "description": "Trunk floor or spare tire.", "example": "/examples/int_spare.jpg", "required": False, "minCount": 1, "mode": "photo"},
        ],
    },
    {
        "group": "Mechanical & Tires",
        "steps": [
            {"stepKey": "engine_bay_wide", "title": "Engine bay", "description": "Wide shot of the engine bay.", "example": "/examples/engine.jpg", "required": True, "minCount": 1, "mode": "photo"},
            {"stepKey": "tire_front_left_tread", "title": "Front left tire tread", "description": "Tread depth close-up.", "example": "/examples/tire_fl.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "tire_front_right_tread", "title": "Front right tire tread", "description": "Tread depth close-up.", "example": "/examples/tire_fr.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "tire_rear_left_tread", "title": "Rear left tire tread", "description": "Tread depth close-up.", "example": "/examples/tire_rl.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "tire_rear_right_tread", "title": "Rear right tire tread", "description": "Tread depth close-up.", "example": "/examples/tire_rr.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "wheels_rims_any_damage", "title": "Wheel/rim damage", "description": "Close-ups of any rim damage.", "example": "/examples/rim.jpg", "required": False, "minCount": 1, "mode": "photo"},
        ],
    },
    {
        "group": "Documents",
        "steps": [
            {"stepKey": "ownership_front", "title": "Ownership front", "description": "Redact address/ID numbers before upload.", "example": "/examples/ownership_front.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "ownership_back", "title": "Ownership back", "description": "Redact address/ID numbers before upload.", "example": "/examples/ownership_back.jpg", "required": False, "minCount": 1, "mode": "photo"},
            {"stepKey": "service_records_optional", "title": "Service records", "description": "Upload service history photos.", "example": "/examples/service_records.jpg", "required": False, "minCount": 1, "mode": "photo"},
        ],
    },
]

REQUIRED_STEP_KEYS: List[str] = [
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
REQUIRED_STEP_SET: Set[str] = set(REQUIRED_STEP_KEYS)


def normalized_step_groups() -> List[Dict[str, Any]]:
    groups: List[Dict[str, Any]] = []
    for group in STEP_GROUPS:
        steps = []
        for step in group["steps"]:
            next_step = dict(step)
            next_step["required"] = step["stepKey"] in REQUIRED_STEP_SET
            next_step["mode"] = "photo"
            steps.append(next_step)
        groups.append({"group": group["group"], "steps": steps})
    return groups


def next_step_key(db: Session, session_id: int) -> Optional[str]:
    rows = db.execute(select(session_assets.c.step_key).where(session_assets.c.session_id == session_id)).fetchall()
    uploaded = {row._mapping["step_key"] for row in rows}
    for step_key in REQUIRED_STEP_KEYS:
        if step_key not in uploaded:
            return step_key
    return None


def asset_response_row(row: Dict[str, Any], seller_token: Optional[str] = None, is_admin: bool = False) -> Dict[str, Any]:
    payload = dict(row)
    if seller_token:
        payload["preview_url"] = f"{API_BASE_URL}/api/sessions/{seller_token}/assets/{row['id']}/preview"
    if is_admin:
        payload["preview_url"] = f"{API_BASE_URL}/api/admin/sessions/{row['session_id']}/assets/{row['id']}/preview"
    return payload


@app.get("/api/steps")
def get_steps():
    return normalized_step_groups()


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
    return {
        "id": session_id,
        "token": token,
        "link": f"{APP_BASE_URL}/seller/{token}",
        "expires_at": expires_at,
        "notification_placeholders": {
            "sms_body": "Capture link: {seller_capture_link}",
            "email_subject": "Vehicle photo capture request",
            "email_body": "Please complete your capture session: {seller_capture_link}",
        },
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
        "assets": [asset_response_row(dict(row._mapping), is_admin=True) for row in assets],
        "reviews": [dict(row._mapping) for row in reviews],
        "next_step_key": next_step_key(db, session_id),
    }


@app.get("/api/admin/sessions/{session_id}/assets/{asset_id}/preview")
def preview_admin_asset(session_id: int, asset_id: int, admin=Depends(require_admin), db: Session = Depends(get_db)):
    row = db.execute(
        select(session_assets).where(session_assets.c.id == asset_id, session_assets.c.session_id == session_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return stream_asset_bytes(row._mapping["file_url"], row._mapping["mime_type"])


@app.post("/api/admin/sessions/{session_id}/review")
def review_session(session_id: int, payload: List[ReviewDecision], admin=Depends(require_admin), db: Session = Depends(get_db)):
    session_row = db.execute(select(capture_sessions).where(capture_sessions.c.id == session_id)).first()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    db.execute(delete(session_reviews).where(session_reviews.c.session_id == session_id))
    for decision in payload:
        db.execute(insert(session_reviews).values(session_id=session_id, step_key=decision.step_key, decision=decision.decision, comment=decision.comment, reviewer_id=int(admin["sub"])))
    new_status = "retake" if any(d.decision == "retake" for d in payload) else "completed"
    db.execute(update(capture_sessions).where(capture_sessions.c.id == session_id).values(status=new_status))
    db.commit()
    return {"status": new_status}


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
        "assets": [asset_response_row(dict(r._mapping), seller_token=token) for r in assets],
        "reviews": [dict(r._mapping) for r in reviews],
        "missing_required": count_missing_required(db, session["id"]),
        "next_step_key": next_step_key(db, session["id"]),
    }


@app.get("/api/sessions/{token}/assets/{asset_id}/preview")
def preview_seller_asset(token: str, asset_id: int, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    row = db.execute(select(session_assets).where(session_assets.c.id == asset_id, session_assets.c.session_id == session_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return stream_asset_bytes(row._mapping["file_url"], row._mapping["mime_type"])


@app.post("/api/sessions/{token}/assets")
async def upload_asset(token: str, step_key: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    if file.content_type is None or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported")

    data = await file.read()
    size_bytes = len(data)
    if size_bytes == 0:
        raise HTTPException(status_code=400, detail="File is empty")
    if size_bytes > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 10MB limit")

    try:
        image = Image.open(BytesIO(data))
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        if width < 1600 and height < 1600:
            raise HTTPException(status_code=400, detail="Image too small (min 1600px on one side)")
        output = BytesIO()
        image.convert("RGB").save(output, format="JPEG", quality=90)
        output.seek(0)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image") from exc

    s3_key = f"sessions/{session_id}/{secrets.token_hex(8)}-{step_key}.jpg"
    s3_client.put_object(Bucket=S3_BUCKET, Key=s3_key, Body=output, ContentType="image/jpeg")
    storage_ref = f"s3://{S3_BUCKET}/{s3_key}"

    result = db.execute(
        insert(session_assets)
        .values(session_id=session_id, step_key=step_key, file_url=storage_ref, mime_type="image/jpeg", width=width, height=height, size_bytes=size_bytes)
        .returning(session_assets.c.id)
    )
    asset_id = result.scalar_one()
    db.commit()
    return {
        "id": asset_id,
        "step_key": step_key,
        "preview_url": f"{API_BASE_URL}/api/sessions/{token}/assets/{asset_id}/preview",
        "width": width,
        "height": height,
        "sizeBytes": size_bytes,
        "next_step_key": next_step_key(db, session_id),
    }


@app.post("/api/sessions/{token}/submit")
def submit_session(token: str, payload: SubmitRequest, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    if not payload.agree_documents_redaction:
        raise HTTPException(status_code=400, detail="Document redaction acknowledgement is required")
    missing = count_missing_required(db, session_id)
    if missing > 0:
        raise HTTPException(status_code=400, detail="Required steps are missing")
    db.execute(update(capture_sessions).where(capture_sessions.c.id == session_id).values(status="submitted", submitted_at=datetime.now(timezone.utc)))
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


def count_missing_required(db: Session, session_id: int) -> int:
    asset_rows = db.execute(select(session_assets.c.step_key).where(session_assets.c.session_id == session_id)).fetchall()
    uploaded = {row._mapping["step_key"] for row in asset_rows}
    return sum(1 for step_key in REQUIRED_STEP_KEYS if step_key not in uploaded)


def stream_asset_bytes(storage_ref: str, mime_type: str):
    bucket, key = parse_storage_ref(storage_ref)
    try:
        obj = s3_client.get_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Asset bytes unavailable") from exc
    headers = {"Cache-Control": "private, max-age=60"}
    return StreamingResponse(obj["Body"], media_type=mime_type or "application/octet-stream", headers=headers)


def parse_storage_ref(storage_ref: str):
    prefix = "s3://"
    if not storage_ref.startswith(prefix):
        raise HTTPException(status_code=500, detail="Invalid storage reference")
    remainder = storage_ref[len(prefix) :]
    bucket, _, key = remainder.partition("/")
    if not bucket or not key:
        raise HTTPException(status_code=500, detail="Invalid storage reference")
    return bucket, key


@app.get("/api/health")
def health():
    return {"status": "ok"}
