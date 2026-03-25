CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
    CREATE TYPE session_status AS ENUM ('draft', 'submitted', 'review', 'retake', 'completed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE review_decision AS ENUM ('pass', 'retake');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'inspector');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(128) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'admin',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capture_sessions (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    status session_status NOT NULL DEFAULT 'draft',
    expires_at TIMESTAMPTZ NOT NULL,
    seller_name VARCHAR(128),
    seller_phone VARCHAR(32),
    listing_id VARCHAR(64),
    vin VARCHAR(32),
    plate VARCHAR(32),
    province VARCHAR(32),
    vehicle_make VARCHAR(64),
    vehicle_model VARCHAR(64),
    vehicle_year VARCHAR(8),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS session_assets (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
    step_key VARCHAR(64) NOT NULL,
    s3_key TEXT NOT NULL,
    file_url TEXT NOT NULL,
    thumb_url TEXT,
    mime_type VARCHAR(64) NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    taken_at TIMESTAMPTZ,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    checksum VARCHAR(128)
);

ALTER TABLE session_assets
    ADD COLUMN IF NOT EXISTS s3_key TEXT;

CREATE TABLE IF NOT EXISTS session_reviews (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
    step_key VARCHAR(64) NOT NULL,
    decision review_decision NOT NULL,
    comment TEXT,
    reviewer_id INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
