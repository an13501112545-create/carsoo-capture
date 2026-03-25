# Carsoo Seller Remote Capture (MVP)

## Architecture (text diagram)
```
Seller Mobile PWA (Next.js)  --->  FastAPI Backend  --->  Postgres
       |                              |                 (sessions/assets/reviews/users)
       |                              |
       |                              +--> MinIO (S3-compatible object storage)
       |
Admin Web (Next.js) --------->  FastAPI Admin APIs  --->  Dealer Package Export JSON
```

## Directory Structure
```
carsoo-capture/
├── apps/
│   ├── api/                 # FastAPI backend + OpenAPI
│   └── web/                 # Next.js PWA (Seller + Admin)
├── db/
│   └── init.sql             # Postgres schema
├── docker-compose.yml
├── .env.example
└── README.md
```

## Product Highlights
- Step-by-step SOP for Canada used-car capture (identity, exterior, interior, mechanical, documents).
- Session link binds a vehicle to a token, supports resume + retake workflow.
- Required-step validation (min counts), image size validation, EXIF rotation.
- Admin review with PASS/RETAKE and comments + dealer package export JSON.

## Tech Choices
- **Backend:** FastAPI (Python) for rapid OpenAPI docs and fast iteration.
- **Frontend:** Next.js 14 PWA for mobile-first seller experience + admin console.
- **Storage:** Postgres + MinIO (S3-compatible) with pre-signed uploads.

## Quick Start (Docker Compose)
```bash
cp .env.example .env

docker compose up --build
```

Then in a new terminal:
```bash
# Seed the default admin user
curl -X POST http://localhost:8000/api/admin/seed
```

### Access Points
- Seller PWA: http://localhost:3000
- Admin login: http://localhost:3000/admin
- API OpenAPI: http://localhost:8000/docs
- MinIO Console: http://localhost:9001 (minioadmin / minioadmin)

## Basic Flow
1. Admin logs in (default: `admin@carsoo.ai` / `admin123`).
2. Admin creates a session and shares the generated secure seller link.
3. Seller opens link on phone and follows one-step-at-a-time camera capture.
4. Each captured photo uploads immediately; required steps auto-advance.
5. Seller can submit once the core required set is complete (optional steps can be skipped).
6. Admin reviews and sets PASS / RETAKE decisions.
7. Export dealer package JSON.

## Seller Camera-First Capture Flow
- The seller page now runs as a mobile-first guided wizard with one active step at a time.
- Primary action is **Take photo** using `accept=\"image/*\"` and `capture=\"environment\"` (browser fallback still allows regular file picker).
- Optional steps expose **Skip for now**; required steps do not.
- After photo selection, the app shows preview + **Retake** + **Next** while upload happens immediately.
- Progress is persisted by uploaded assets and the step cursor (local storage per token) so sellers can resume the same link later.
- Submission now checks only the core required set (10 critical photos), while all other steps are additional/optional.
- Admin session creation now returns placeholder SMS/email payloads for notification services, without hard-coding Twilio/SendGrid integrations.

## Environment Variables
See `.env.example` for defaults. Key entries:
- `DATABASE_URL`
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- `APP_BASE_URL`, `NEXT_PUBLIC_API_BASE`

## API (OpenAPI)
FastAPI auto-generates full OpenAPI docs at:
- http://localhost:8000/docs

## Example cURL Tests
```bash
# Admin login
curl -X POST http://localhost:8000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@carsoo.ai","password":"admin123"}'

# Create session (replace TOKEN)
curl -X POST http://localhost:8000/api/admin/sessions \
  -H "Authorization: Bearer TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"vin":"1HGCM82633A004352","plate":"ABC123"}'

# Seller fetch steps
curl http://localhost:8000/api/steps

# Seller session progress (replace SESSION_TOKEN)
curl http://localhost:8000/api/sessions/SESSION_TOKEN

# Export dealer package (replace TOKEN + SESSION_ID)
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:8000/api/admin/sessions/SESSION_ID/export
```

## Security Notes
- Basic CSP + Referrer-Policy headers in Next.js.
- For production, terminate TLS (HTTPS) via reverse proxy (NGINX/Cloudflare).

## TODO (post-MVP)
- SMS/WhatsApp integrations.
- Zip download of session assets.
- Advanced role-based access (Inspector assignment).
- AI damage tagging and condition scoring pipelines.
