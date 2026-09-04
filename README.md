# GMB Multi-Tenant Review Booster Platform

A production-ready Node.js SaaS platform for Google Business Profile (GMB) review growth, tenant isolation, and administrative management.

## Features
- Multi-tenant architecture with Firestore database backend.
- Master Control Panel at `/master` for business provisioning and Place ID verification.
- Dynamic Groq AI category-specific review suggestion generation.
- Dynamic QR code generator for active business tenants.
- HMAC SHA256 verified Razorpay Autopay subscription integration.
- Production hardened security with scrypt password hashing and rate limiting.

## Setup & Running
1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in required secrets (`MASTER_PASSWORD`, `FIREBASE_PROJECT_ID`, etc.).
4. Run `npm start`.
5. Access Master Admin panel at `/master`.
