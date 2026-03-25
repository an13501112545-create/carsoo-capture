import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3
from botocore.config import Config
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, insert, update, delete, text
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from PIL import Image, ImageOps
from io import BytesIO

from .db import get_db
from .db import engine
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
PREVIEW_TOKEN_TTL_SECONDS = int(os.getenv("PREVIEW_TOKEN_TTL_SECONDS", "300"))

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
    allow_headers=["*"]
)


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


class AssetConfirm(BaseModel):
    step_key: str
    s3_key: str
    mime_type: str


class ReviewDecision(BaseModel):
    step_key: str
    decision: str
    comment: Optional[str] = None


class SubmitRequest(BaseModel):
    agree_documents_redaction: bool = False


class PresignRequest(BaseModel):
    filename: str
    mime_type: str


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
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS seller_email VARCHAR(128)"))
        conn.execute(text("ALTER TABLE session_assets ADD COLUMN IF NOT EXISTS s3_key TEXT"))


STEP_GROUPS = [
    {
        "group": "Vehicle Identity",
        "steps": [
            {
                "stepKey": "odometer_closeup",
                "title": "Odometer close-up",
                "description": "Capture the illuminated odometer clearly.",
                "example": "/examples/odometer.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "vin_windshield",
                "title": "VIN windshield",
                "description": "Photograph the VIN plate through the windshield.",
                "example": "/examples/vin_windshield.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "vin_door_jamb",
                "title": "VIN door jamb",
                "description": "Photograph the VIN label on the door jamb.",
                "example": "/examples/vin_door.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "plate_front_or_rear",
                "title": "License plate",
                "description": "Photograph the rear license plate clearly.",
                "example": "/examples/plate.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "keys_photo",
                "title": "Keys",
                "description": "Photograph the key fob and spare keys if any.",
                "example": "/examples/keys.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
        ],
    },
    {
        "group": "Exterior",
        "steps": [
            {
                "stepKey": "ext_front",
                "title": "Front",
                "description": "Front view of the vehicle.",
                "example": "/examples/ext_front.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_front_left_45",
                "title": "Front left 45°",
                "description": "Front-left 45 degree angle.",
                "example": "/examples/ext_front_left.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_front_right_45",
                "title": "Front right 45°",
                "description": "Front-right 45 degree angle.",
                "example": "/examples/ext_front_right.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_rear",
                "title": "Rear",
                "description": "Rear view of the vehicle.",
                "example": "/examples/ext_rear.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_rear_left_45",
                "title": "Rear left 45°",
                "description": "Rear-left 45 degree angle.",
                "example": "/examples/ext_rear_left.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_rear_right_45",
                "title": "Rear right 45°",
                "description": "Rear-right 45 degree angle.",
                "example": "/examples/ext_rear_right.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_left_side",
                "title": "Left side",
                "description": "Driver-side profile.",
                "example": "/examples/ext_left.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_right_side",
                "title": "Right side",
                "description": "Passenger-side profile.",
                "example": "/examples/ext_right.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_roof_optional",
                "title": "Roof (optional)",
                "description": "Roof condition if accessible.",
                "example": "/examples/ext_roof.jpg",
                "required": False,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "ext_undercarriage_optional",
                "title": "Undercarriage (optional)",
                "description": "Undercarriage if possible.",
                "example": "/examples/ext_undercarriage.jpg",
                "required": False,
                "minCount": 1,
                "mode": "photo",
            },
        ],
    },
    {
        "group": "Interior",
        "steps": [
            {
                "stepKey": "int_dashboard_wide",
                "title": "Dashboard wide",
                "description": "Dashboard, steering wheel, and gauges.",
                "example": "/examples/int_dashboard.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_center_console",
                "title": "Center console",
                "description": "Center console and shifter.",
                "example": "/examples/int_console.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_infotainment_on",
                "title": "Infotainment on",
                "description": "Power on the infotainment screen.",
                "example": "/examples/int_infotainment.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_front_seats",
                "title": "Front seats",
                "description": "Front seats and cabin.",
                "example": "/examples/int_front_seats.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_rear_seats",
                "title": "Rear seats",
                "description": "Rear seating area.",
                "example": "/examples/int_rear_seats.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_driver_door_panel",
                "title": "Driver door panel",
                "description": "Driver door panel and controls.",
                "example": "/examples/int_door.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_headliner_sunroof_optional",
                "title": "Headliner / Sunroof (optional)",
                "description": "Headliner or sunroof condition.",
                "example": "/examples/int_headliner.jpg",
                "required": False,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_trunk_open",
                "title": "Trunk open",
                "description": "Open trunk view.",
                "example": "/examples/int_trunk.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "int_trunk_floor_spare_optional",
                "title": "Trunk floor/spare (optional)",
                "description": "Trunk floor or spare tire.",
                "example": "/examples/int_spare.jpg",
                "required": False,
                "minCount": 1,
                "mode": "photo",
            },
        ],
    },
    {
        "group": "Mechanical & Tires",
        "steps": [
            {
                "stepKey": "engine_bay_wide",
                "title": "Engine bay",
                "description": "Wide shot of the engine bay.",
                "example": "/examples/engine.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "tire_front_left_tread",
                "title": "Front left tire tread",
                "description": "Tread depth close-up.",
                "example": "/examples/tire_fl.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "tire_front_right_tread",
                "title": "Front right tire tread",
                "description": "Tread depth close-up.",
                "example": "/examples/tire_fr.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "tire_rear_left_tread",
                "title": "Rear left tire tread",
                "description": "Tread depth close-up.",
                "example": "/examples/tire_rl.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "tire_rear_right_tread",
                "title": "Rear right tire tread",
                "description": "Tread depth close-up.",
                "example": "/examples/tire_rr.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
            {
                "stepKey": "wheels_rims_any_damage",
                "title": "Wheel/rim damage",
                "description": "Close-ups of any rim damage.",
                "example": "/examples/rim.jpg",
                "required": True,
                "minCount": 1,
                "mode": "photo",
            },
        ],
    },
    {
        "group": "Documents",
        "steps": [
            {
                "stepKey": "ownership_front",
                "title": "Ownership front",
                "description": "Redact address/ID numbers before upload.",
                "example": "/examples/ownership_front.jpg",
                "required": False,
                "minCount": 1,
                "mode": "doc",
            },
            {
                "stepKey": "ownership_back",
                "title": "Ownership back",
                "description": "Redact address/ID numbers before upload.",
                "example": "/examples/ownership_back.jpg",
                "required": False,
                "minCount": 1,
                "mode": "doc",
            },
            {
                "stepKey": "service_records_optional",
                "title": "Service records",
                "description": "Upload service history photos.",
                "example": "/examples/service_records.jpg",
                "required": False,
                "minCount": 1,
                "mode": "doc",
            },
        ],
    },
]

CORE_REQUIRED_STEPS = {
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
}


def get_step_groups() -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for group in STEP_GROUPS:
        normalized_steps: List[Dict[str, Any]] = []
        for step in group["steps"]:
            item = dict(step)
            item["required"] = item["stepKey"] in CORE_REQUIRED_STEPS
            normalized_steps.append(item)
        normalized.append({"group": group["group"], "steps": normalized_steps})
    return normalized


def get_flat_steps() -> List[Dict[str, Any]]:
    return [step for group in get_step_groups() for step in group["steps"]]


def get_asset_counts(asset_rows: List[Any]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for row in asset_rows:
        step_key = row._mapping["step_key"]
        counts[step_key] = counts.get(step_key, 0) + 1
    return counts


def get_next_step_key(asset_rows: List[Any]) -> Optional[str]:
    counts = get_asset_counts(asset_rows)
    flat_steps = get_flat_steps()
    for required in (True, False):
        for step in flat_steps:
            if step["required"] != required:
                continue
            if counts.get(step["stepKey"], 0) < step["minCount"]:
                return step["stepKey"]
    return None


def sign_preview_token(session_id: int, asset_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": JWT_ISSUER,
        "kind": "preview",
        "session_id": session_id,
        "asset_id": asset_id,
        "iat": now,
        "exp": now + timedelta(seconds=PREVIEW_TOKEN_TTL_SECONDS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def build_notification_payloads(seller_phone: Optional[str], seller_email: Optional[str], link: str) -> Dict[str, Optional[Dict[str, str]]]:
    sms_payload = None
    email_payload = None
    if seller_phone:
        sms_payload = {
            "provider": "placeholder",
            "to": seller_phone,
            "message": f"Carsoo photo capture link: {link}",
        }
    if seller_email:
        email_payload = {
            "provider": "placeholder",
            "to": seller_email,
            "subject": "Carsoo capture session",
            "text": f"Use this secure link to capture your vehicle photos: {link}",
        }
    return {"sms": sms_payload, "email": email_payload}


@app.get("/api/steps")
def get_steps():
    return get_step_groups()


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
    link = f"{APP_BASE_URL}/seller/{token}"
    return {
        "id": session_id,
        "token": token,
        "link": link,
        "expires_at": expires_at,
        "notifications": build_notification_payloads(payload.seller_phone, payload.seller_email, link),
    }


@app.get("/api/admin/sessions", response_model=List[AdminSessionList])
def list_sessions(admin=Depends(require_admin), db: Session = Depends(get_db)):
    sessions = db.execute(select(capture_sessions)).fetchall()
    results = []
    for row in sessions:
        session = row._mapping
        missing_required = count_missing_required(db, session["id"])
        results.append(
            AdminSessionList(
                id=session["id"],
                status=session["status"],
                vin=session["vin"],
                plate=session["plate"],
                created_at=session["created_at"],
                missing_required=missing_required,
            )
        )
    return results


@app.get("/api/admin/sessions/{session_id}")
def get_session_admin(session_id: int, admin=Depends(require_admin), db: Session = Depends(get_db)):
    session_row = db.execute(select(capture_sessions).where(capture_sessions.c.id == session_id)).first()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")
    assets = db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()
    reviews = db.execute(select(session_reviews).where(session_reviews.c.session_id == session_id)).fetchall()
    return {
        "session": dict(session_row._mapping),
        "assets": [dict(row._mapping) for row in assets],
        "reviews": [dict(row._mapping) for row in reviews],
    }


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
                "url": asset["file_url"],
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
    assets_payload = []
    for row in assets:
        asset = dict(row._mapping)
        signed = sign_preview_token(session["id"], asset["id"])
        asset["preview_url"] = f"/api/sessions/{token}/assets/{asset['id']}/preview?sig={signed}"
        assets_payload.append(asset)
    return {
        "session": dict(session),
        "assets": assets_payload,
        "reviews": [dict(row._mapping) for row in reviews],
        "missing_required": count_missing_required(db, session["id"]),
        "next_step_key": get_next_step_key(assets),
    }


@app.post("/api/sessions/{token}/presign")
def presign_upload(token: str, payload: PresignRequest, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    key = f"sessions/{session_id}/{secrets.token_hex(8)}-{payload.filename}"
    url = s3_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": S3_BUCKET, "Key": key, "ContentType": payload.mime_type},
        ExpiresIn=3600,
    )
    return {"uploadUrl": url, "s3Key": key}


@app.post("/api/sessions/{token}/assets")
def confirm_asset(token: str, payload: AssetConfirm, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    if not payload.mime_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported")
    try:
        obj = s3_client.get_object(Bucket=S3_BUCKET, Key=payload.s3_key)
    except s3_client.exceptions.NoSuchKey as exc:
        raise HTTPException(status_code=404, detail="Upload not found") from exc

    data = obj["Body"].read()
    size_bytes = len(data)
    if size_bytes > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 10MB limit")

    width = 0
    height = 0
    if payload.mime_type.startswith("image/"):
        try:
            image = Image.open(BytesIO(data))
            image = ImageOps.exif_transpose(image)
            width, height = image.size
            if width < 1600 and height < 1600:
                raise HTTPException(status_code=400, detail="Image too small (min 1600px on one side)")
            buffer = BytesIO()
            image.save(buffer, format=image.format or "JPEG")
            buffer.seek(0)
            s3_client.put_object(
                Bucket=S3_BUCKET,
                Key=payload.s3_key,
                Body=buffer,
                ContentType=payload.mime_type,
            )
        except HTTPException:
            raise
        except Exception as exc:  # pylint: disable=broad-except
            raise HTTPException(status_code=400, detail="Invalid image") from exc

    file_url = f"{S3_ENDPOINT}/{S3_BUCKET}/{payload.s3_key}"
    result = db.execute(
        insert(session_assets)
        .values(
            session_id=session_id,
            step_key=payload.step_key,
            s3_key=payload.s3_key,
            file_url=file_url,
            mime_type=payload.mime_type,
            width=width,
            height=height,
            size_bytes=size_bytes,
        )
        .returning(session_assets.c.id)
    )
    asset_id = result.scalar_one()
    db.commit()
    sig = sign_preview_token(session_id, asset_id)
    return {
        "id": asset_id,
        "fileUrl": file_url,
        "previewUrl": f"/api/sessions/{token}/assets/{asset_id}/preview?sig={sig}",
        "width": width,
        "height": height,
        "sizeBytes": size_bytes,
        "next_step_key": get_next_step_key(db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()),
    }


@app.post("/api/sessions/{token}/submit")
def submit_session(token: str, payload: SubmitRequest, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    if not payload.agree_documents_redaction:
        raise HTTPException(status_code=400, detail="Document redaction acknowledgement is required")
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


@app.get("/api/sessions/{token}/assets/{asset_id}/preview")
def preview_asset(token: str, asset_id: int, sig: str, db: Session = Depends(get_db)):
    session_id = get_session_id(db, token)
    try:
        claims = jwt.decode(sig, JWT_SECRET, algorithms=["HS256"], issuer=JWT_ISSUER)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid preview signature") from exc
    if claims.get("kind") != "preview" or claims.get("session_id") != session_id or claims.get("asset_id") != asset_id:
        raise HTTPException(status_code=401, detail="Invalid preview signature")
    asset = db.execute(
        select(session_assets).where(
            session_assets.c.id == asset_id,
            session_assets.c.session_id == session_id,
        )
    ).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    key = asset._mapping.get("s3_key")
    if not key:
        raise HTTPException(status_code=404, detail="Asset unavailable")
    obj = s3_client.get_object(Bucket=S3_BUCKET, Key=key)
    return StreamingResponse(obj["Body"], media_type=asset._mapping["mime_type"])


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
    asset_rows = db.execute(select(session_assets).where(session_assets.c.session_id == session_id)).fetchall()
    counts = get_asset_counts(asset_rows)
    missing = 0
    for group in get_step_groups():
        for step in group["steps"]:
            if step["required"]:
                if counts.get(step["stepKey"], 0) < step["minCount"]:
                    missing += 1
    return missing


@app.get("/api/health")
def health():
    return {"status": "ok"}
