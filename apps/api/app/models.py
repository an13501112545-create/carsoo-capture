from sqlalchemy import (
    Table,
    Column,
    Integer,
    String,
    DateTime,
    Text,
    ForeignKey,
    Enum,
    Boolean,
    MetaData,
)
from sqlalchemy.sql import func

metadata = MetaData()

capture_sessions = Table(
    "capture_sessions",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("token_hash", String(128), unique=True, nullable=False),
    Column(
        "status",
        Enum(
            "draft",
            "submitted",
            "review",
            "retake",
            "completed",
            name="session_status",
        ),
        nullable=False,
        default="draft",
    ),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("seller_name", String(128)),
    Column("seller_phone", String(32)),
    Column("listing_id", String(64)),
    Column("vin", String(32)),
    Column("plate", String(32)),
    Column("province", String(32)),
    Column("vehicle_make", String(64)),
    Column("vehicle_model", String(64)),
    Column("vehicle_year", String(8)),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now()),
    Column("submitted_at", DateTime(timezone=True)),
)

session_assets = Table(
    "session_assets",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("session_id", Integer, ForeignKey("capture_sessions.id"), nullable=False),
    Column("step_key", String(64), nullable=False),
    Column("s3_key", Text),
    Column("file_url", Text, nullable=False),
    Column("thumb_url", Text),
    Column("mime_type", String(64), nullable=False),
    Column("width", Integer, nullable=False),
    Column("height", Integer, nullable=False),
    Column("size_bytes", Integer, nullable=False),
    Column("taken_at", DateTime(timezone=True)),
    Column("uploaded_at", DateTime(timezone=True), server_default=func.now()),
    Column("checksum", String(128)),
)

session_reviews = Table(
    "session_reviews",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("session_id", Integer, ForeignKey("capture_sessions.id"), nullable=False),
    Column("step_key", String(64), nullable=False),
    Column("decision", Enum("pass", "retake", name="review_decision"), nullable=False),
    Column("comment", Text),
    Column("reviewer_id", Integer, ForeignKey("users.id")),
    Column("updated_at", DateTime(timezone=True), server_default=func.now(), onupdate=func.now()),
)

users = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("email", String(128), unique=True, nullable=False),
    Column("password_hash", String(255), nullable=False),
    Column("role", Enum("admin", "inspector", name="user_role"), nullable=False, default="admin"),
    Column("is_active", Boolean, default=True),
    Column("created_at", DateTime(timezone=True), server_default=func.now()),
)
