# Divya Rathod Beauty Salon — Review System

A small Node.js SaaS-style MVP for a QR feedback/review page and an admin dashboard.

## Included
- Divya Rathod Beauty Salon profile preconfigured from the supplied business data.
- Customer QR landing page at `/r/divya-rathod-beauty-salon`.
- 1–5 star genuine feedback flow.
- Suggested feedback phrases customers can tap to help write their own feedback.
- Google review redirect after submission; the customer still submits the Google review themselves.
- Admin dashboard at `/admin`.
- Admin password defaults to `5922` (change `ADMIN_PASSWORD` in production).
- QR code generator.
- Razorpay subscription endpoint for a monthly plan; configure the Razorpay plan ID and API keys in `.env`.

## Run
1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `GOOGLE_REVIEW_URL` to the business's actual Google review URL.
5. For billing, create a Razorpay monthly subscription plan for ₹199 and set its ID as `RAZORPAY_PLAN_ID`; add your Razorpay key ID and secret.
6. Set `BASE_URL` to the public URL once deployed.
7. Run `npm start`.
8. Open `/admin` and log in with `5922`.

## Important
The Google-review button is not restricted to only 5-star ratings. Customers can leave an honest rating and then choose whether to share it on Google. The system does not post to a customer's Google account automatically.

For production, replace the simple in-memory session/data storage with Supabase/PostgreSQL, hash the admin password, add proper Razorpay webhook signature verification, and use HTTPS.
