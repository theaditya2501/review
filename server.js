const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { initializeApp } = require("firebase/app");
const { 
  getFirestore, 
  collection, 
  addDoc, 
  getDocs, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where,
  orderBy 
} = require("firebase/firestore");

let Razorpay;
try {
  Razorpay = require('razorpay');
} catch (e) {
  console.log('Razorpay package initialized');
}

const app = express();

// Security Headers & CORS Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Production CORS handling
  const allowedOrigin = process.env.FRONTEND_URL || '*';
  const origin = req.headers.origin;
  if (allowedOrigin === '*' || allowedOrigin === origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token, x-master-token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// JSON Parser with Webhook Raw Body Exception
app.use((req, res, next) => {
  if (req.originalUrl === '/api/razorpay/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

function getReqBaseUrl(req) {
  const host = req.headers.host || req.headers['x-forwarded-host'] || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${host}`;
}
const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

// Firebase Configuration (buildaura-2f728)
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyC28f1Hwhzbg2lv8zAP_EzQZtf0iY37phU",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "buildaura-2f728.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "buildaura-2f728",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "buildaura-2f728.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "762817548547",
  appId: process.env.FIREBASE_APP_ID || "1:762817548547:web:caf84a2652ed56b17a1936",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-9LSFHED9XQ"
};

// Initialize Firebase App & Firestore Instance
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
console.log('🔥 Connected to Firebase Firestore (buildaura-2f728)');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Razorpay Production Credentials (Loaded strictly from process.env)
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const razorpayPlanId = process.env.RAZORPAY_PLAN_ID || '';
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

let rzpInstance = null;
if (Razorpay && razorpayKeyId && razorpayKeySecret) {
  try {
    rzpInstance = new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    });
  } catch (e) {
    console.error('Razorpay initialization error:', e.message);
  }
}

// In-memory active sessions with Expiration
const tenantSessions = new Map(); // token -> { tenantSlug, expiresAt }
const masterSessions = new Map(); // token -> { expiresAt }

// Master Password from Environment Variables (Strictly required in production)
const MASTER_PASS = process.env.MASTER_PASSWORD;

// Password Security Helpers using Node.js scrypt
function hashPassword(password) {
  if (!password) {
    throw new Error('Password is required for hashing.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }
  const [salt, key] = storedHash.split(':');
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey);
}

// In-Memory Rate Limiting Helper
const rateLimitMap = new Map();
function applyRateLimit(req, res, actionName, maxRequests = 10, windowMs = 60000) {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const key = `${actionName}:${clientIp}`;
  const now = Date.now();

  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, []);
  }

  const timestamps = rateLimitMap.get(key).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
    res.status(429).json({
      error: `Too many requests for ${actionName}. Please try again later.`
    });
    return false;
  }

  timestamps.push(now);
  rateLimitMap.set(key, timestamps);
  return true;
}

// Audit Logging Helper
async function createAuditLog(actor, action, tenantSlug = '', details = {}) {
  const auditItem = {
    actor: String(actor || 'System'),
    action: String(action),
    tenantSlug: String(tenantSlug || ''),
    details,
    timestamp: new Date().toISOString()
  };

  try {
    const colRef = collection(db, 'audit_logs');
    await addDoc(colRef, auditItem);
  } catch (e) {
    console.warn('Audit log write notice:', e.message);
  }
}

// Local Cache Helper (Optional Developer Synchronization Only)
function saveLocalBusinesses(list) {
  try {
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {}
}

// Firestore Single Source of Truth Helpers for Multi-Tenant Businesses
async function fetchAllBusinesses() {
  const colRef = collection(db, 'businesses');
  const snapshot = await getDocs(colRef);
  const list = [];
  snapshot.forEach(docSnap => {
    list.push({ id: docSnap.id, ...docSnap.data() });
  });
  saveLocalBusinesses(list);
  return list;
}

async function fetchBusinessBySlug(slug) {
  if (!slug) return null;
  const targetSlug = String(slug).toLowerCase().trim();
  if (!targetSlug) return null;

  const docRef = doc(db, 'businesses', targetSlug);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() };
  }
  return null;
}

async function saveFirestoreBusiness(businessData) {
  if (!businessData || (!businessData.slug && !businessData.id)) return false;
  const slug = String(businessData.slug || businessData.id).toLowerCase().trim();
  const payload = {
    ...businessData,
    id: slug,
    slug,
    updatedAt: new Date().toISOString()
  };

  try {
    const docRef = doc(db, 'businesses', slug);
    await setDoc(docRef, payload, { merge: true });
    return true;
  } catch (e) {
    console.error('Error writing business to Firestore:', e.message);
    return false;
  }
}

async function fetchTenantReviews(tenantSlug) {
  if (!tenantSlug) return [];
  const targetSlug = String(tenantSlug).toLowerCase().trim();

  try {
    const colRef = collection(db, 'reviews');
    const q = query(colRef, where('tenantSlug', '==', targetSlug));
    const snapshot = await getDocs(q);
    const list = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() });
    });
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (e) {
    console.error('Firestore reviews fetch error:', e.message);
    let list = getLocalSubmissions();
    if (targetSlug) {
      list = list.filter(r => (r.tenantSlug || '').toLowerCase().trim() === targetSlug);
    }
    return list;
  }
}

// Authentication Middlewares (Header-based with Expiration Enforcement)
function extractToken(req, headerName) {
  const customHeader = req.headers[headerName];
  if (customHeader) return String(customHeader).trim();
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

function tenantAuth(req, res, next) {
  const token = extractToken(req, 'x-admin-token');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
  }

  const session = tenantSessions.get(token);
  if (!session || !session.expiresAt || session.expiresAt <= Date.now()) {
    if (session) tenantSessions.delete(token);
    return res.status(401).json({ error: 'Session expired or invalid' });
  }

  req.tenantSession = session;
  next();
}

function masterAuth(req, res, next) {
  const token = extractToken(req, 'x-master-token');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing Master Control token' });
  }

  const session = masterSessions.get(token);
  if (!session || !session.expiresAt || session.expiresAt <= Date.now()) {
    if (session) masterSessions.delete(token);
    return res.status(401).json({ error: 'Master Control session expired or invalid' });
  }

  req.masterSession = session;
  next();
}

// Helper to extract initials from business name
function getInitials(name) {
  const words = String(name || 'GMB').trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return words[0].substring(0, 2).toUpperCase();
}

// Helper to validate and extract Place ID or Google Maps link
function validateAndExtractPlaceId(input) {
  const str = String(input || '').trim();
  if (!str) return { valid: false, error: 'Google Business Profile could not be verified. Please check the Place ID and try again.' };

  if (str.startsWith('http://') || str.startsWith('https://')) {
    const placeIdMatch = str.match(/placeid=([a-zA-Z0-9_-]+)/i);
    if (placeIdMatch && placeIdMatch[1]) {
      return { valid: true, placeId: placeIdMatch[1], reviewUrl: `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}` };
    }
    if (/google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(str)) {
      return { valid: true, placeId: str, reviewUrl: str };
    }
    return { valid: false, error: 'Google Business Profile could not be verified. Please check the Place ID and try again.' };
  }

  if ((str.startsWith('ChIJ') || str.length >= 15) && /^[a-zA-Z0-9_-]{15,250}$/.test(str)) {
    return { valid: true, placeId: str, reviewUrl: `https://search.google.com/local/writereview?placeid=${str}` };
  }

  return { valid: false, error: 'Google Business Profile could not be verified. Please check the Place ID and try again.' };
}

function formatGoogleReviewUrl(placeId, customUrl) {
  const input = String(placeId || customUrl || '').trim();
  if (!input) return '';
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const match = input.match(/placeid=([a-zA-Z0-9_-]+)/i);
    if (match && match[1]) {
      return `https://search.google.com/local/writereview?placeid=${match[1]}`;
    }
    return input;
  }
  return `https://search.google.com/local/writereview?placeid=${input}`;
}

function createSlug(name) {
  return String(name || 'my-business')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || 'my-business';
}

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  });
});

// --- PUBLIC TENANT ENDPOINTS ---

app.get('/api/business', async (req, res) => {
  const slug = req.query.tenant || req.query.slug;
  if (!slug) {
    return res.status(400).json({ error: 'Tenant slug is required' });
  }
  const biz = await fetchBusinessBySlug(slug);
  if (!biz || biz.status === 'deleted') {
    return res.status(404).json({ error: 'Business Not Found', slug });
  }
  const status = biz.status || 'pending_setup';
  const hasPlaceId = Boolean(biz.googlePlaceId && biz.googlePlaceId.trim());
  const googleSyncStatus = biz.googleSyncStatus || (hasPlaceId ? 'pending_sync' : 'not_configured');

  res.json({
    id: biz.id,
    slug: biz.slug,
    name: biz.name,
    tagline: biz.tagline || '',
    category: biz.category || 'General Business',
    area: biz.area || '',
    address: biz.address || '',
    phone: biz.phone || '',
    website: biz.website || '',
    instagram: biz.instagram || '',
    logoUrl: biz.logoUrl || '',
    initials: biz.initials || getInitials(biz.name),
    googlePlaceId: biz.googlePlaceId || '',
    googleReviewUrl: formatGoogleReviewUrl(biz.googlePlaceId, biz.googleReviewUrl),
    googleSyncStatus,
    googleLastSyncedAt: biz.googleLastSyncedAt || null,
    googleData: biz.googleData || null,
    services: biz.services || [],
    staffList: biz.staffList || [],
    status,
    setupStatus: status === 'active' ? 'completed' : 'pending'
  });
});

app.post('/api/reviews', async (req, res) => {
  if (!applyRateLimit(req, res, 'review_submission', 10, 60000)) return;

  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
  }

  const tenantSlug = String(req.body.tenantSlug || req.body.slug || '').toLowerCase().trim();
  if (!tenantSlug) {
    return res.status(400).json({ error: 'Tenant slug is required' });
  }
  const biz = await fetchBusinessBySlug(tenantSlug);
  if (!biz || biz.status === 'deleted') {
    return res.status(404).json({ error: 'Business Not Found', slug: tenantSlug });
  }

  if (biz.status === 'paused') {
    return res.status(403).json({ error: 'Service temporarily paused by management.' });
  }

  if (biz.status === 'pending_setup' || (!biz.googlePlaceId && !biz.googleReviewUrl)) {
    return res.status(403).json({ error: 'Profile setup is in progress. Review submission is not active yet.' });
  }

  const reviewItem = {
    tenantSlug: biz.slug,
    businessId: biz.id,
    businessSlug: biz.slug,
    businessName: biz.name,
    rating,
    service: String(req.body.service || '').trim().substring(0, 200),
    staff: String(req.body.staff || '').trim().substring(0, 100),
    feedback: String(req.body.feedback || '').trim().substring(0, 2000),
    tags: Array.isArray(req.body.tags) ? req.body.tags.slice(0, 10) : [],
    customerName: String(req.body.customerName || '').trim().substring(0, 100),
    customerPhone: String(req.body.customerPhone || '').trim().substring(0, 20),
    consentContact: Boolean(req.body.consentContact),
    status: 'new',
    createdAt: new Date().toISOString()
  };

  let docId = crypto.randomUUID();

  try {
    const colRef = collection(db, 'reviews');
    const docRef = await addDoc(colRef, reviewItem);
    docId = docRef.id;
  } catch (e) {
    console.error('Error saving review to Firestore:', e.message);
  }

  const localList = getLocalSubmissions();
  localList.unshift({ id: docId, ...reviewItem });
  saveLocalSubmissions(localList);

  res.json({
    ok: true,
    id: docId,
    isPositive: rating >= 4,
    googleReviewUrl: formatGoogleReviewUrl(biz.googlePlaceId, biz.googleReviewUrl),
    googlePlaceId: biz.googlePlaceId || ''
  });
});

// Dynamic QR Code API for specific tenant
app.get('/api/qr', async (req, res) => {
  try {
    const tenantSlug = req.query.tenant || req.query.slug;
    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant slug is required' });
    }
    const biz = await fetchBusinessBySlug(tenantSlug);
    if (!biz || biz.status === 'deleted') {
      return res.status(404).json({ error: 'Business Not Found', slug: tenantSlug });
    }
    const baseUrl = getReqBaseUrl(req);
    const reviewUrl = `${baseUrl}/r/${biz.slug}`;
    const status = biz.status || 'pending_setup';

    if (status !== 'active') {
      return res.json({
        active: false,
        status,
        url: reviewUrl,
        data: null,
        message: 'QR Code Pending Setup',
        businessName: biz.name,
        slug: biz.slug,
        category: biz.category || 'General Business',
        initials: biz.initials || getInitials(biz.name),
        logoUrl: biz.logoUrl || ''
      });
    }

    const dataUrl = await QRCode.toDataURL(reviewUrl, {
      width: 1200,
      margin: 2,
      color: {
        dark: '#2A1725',
        light: '#FFFFFF'
      }
    });

    res.json({
      active: true,
      status,
      url: reviewUrl,
      data: dataUrl,
      businessName: biz.name,
      slug: biz.slug,
      category: biz.category || 'General Business',
      initials: biz.initials || getInitials(biz.name),
      logoUrl: biz.logoUrl || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- RAZORPAY AUTOPAY SUBSCRIPTION & WEBHOOK ENDPOINTS ---

app.get('/api/razorpay/config', (req, res) => {
  res.json({
    key: razorpayKeyId,
    plan_id: razorpayPlanId,
    amount: 19900,
    currency: 'INR',
    name: 'GMB Google Review Booster Platform',
    description: '₹199/Month Autopay Subscription'
  });
});

app.post('/api/razorpay/create-subscription', async (req, res) => {
  if (!applyRateLimit(req, res, 'razorpay_create_sub', 10, 60000)) return;

  const { businessName, phone } = req.body;

  if (!rzpInstance || !razorpayPlanId) {
    return res.status(503).json({
      error: 'Payment service is temporarily unavailable. Razorpay keys not configured.'
    });
  }

  try {
    const sub = await rzpInstance.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      total_count: 12,
      notes: {
        businessName: businessName || 'GMB Account',
        phone: phone || ''
      }
    });
    return res.json({ ok: true, subscription: sub });
  } catch (err) {
    console.error('Razorpay subscription creation error:', err.message);
    res.status(500).json({ error: 'Failed to create Razorpay subscription.' });
  }
});

// Verify Subscription & Provision Account as "Pending Setup" (HMAC SHA256 Verification)
app.post('/api/razorpay/verify-subscription', async (req, res) => {
  if (!applyRateLimit(req, res, 'razorpay_verify_sub', 10, 60000)) return;

  const {
    razorpay_payment_id,
    razorpay_subscription_id,
    razorpay_signature,
    businessName,
    phone,
    password,
    mapsUrl
  } = req.body;

  if (!razorpayKeySecret) {
    return res.status(503).json({ error: 'Payment service is temporarily unavailable. Razorpay is not configured.' });
  }

  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required Razorpay payment details.' });
  }

  // Server-side HMAC Signature Verification
  const expectedSig1 = crypto
    .createHmac('sha256', razorpayKeySecret)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');

  const expectedSig2 = crypto
    .createHmac('sha256', razorpayKeySecret)
    .update(`${razorpay_subscription_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValidSig =
    (razorpay_signature.length === expectedSig1.length && crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSig1))) ||
    (razorpay_signature.length === expectedSig2.length && crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSig2)));

  if (!isValidSig) {
    createAuditLog('System', 'Payment Verification Failed: Invalid Signature', '', { paymentId: razorpay_payment_id });
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  const baseSlug = createSlug(businessName);
  let slug = baseSlug;
  let counter = 1;
  while (await fetchBusinessBySlug(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  let googlePlaceId = '';
  let googleReviewUrl = '';
  if (mapsUrl) {
    const val = validateAndExtractPlaceId(mapsUrl);
    if (val.valid) {
      googlePlaceId = val.placeId;
      googleReviewUrl = val.reviewUrl;
    }
  }

  if (!password || !String(password).trim()) {
    return res.status(400).json({ error: 'Account password is required.' });
  }

  const passwordHash = hashPassword(String(password).trim());

  const newBusiness = {
    id: slug,
    slug,
    name: businessName || 'New GMB Business',
    tagline: 'Google Verified Business',
    category: 'General Business',
    phone: phone || '',
    passwordHash,
    status: 'pending_setup',
    setupStatus: 'pending',
    subscriptionStatus: 'active',
    razorpaySubscriptionId: razorpay_subscription_id,
    razorpayPaymentId: razorpay_payment_id,
    googlePlaceId,
    googleReviewUrl,
    googleSyncStatus: googlePlaceId ? 'pending_sync' : 'not_configured',
    initials: getInitials(businessName),
    logoUrl: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveFirestoreBusiness(newBusiness);

  const paymentRecord = {
    id: razorpay_payment_id,
    subscriptionId: razorpay_subscription_id,
    slug,
    name: businessName,
    phone,
    amount: 199,
    plan: '₹199/mo Autopay',
    status: 'Captured',
    date: new Date().toISOString()
  };

  try {
    const colRef = collection(db, 'payments');
    await addDoc(colRef, paymentRecord);
  } catch (e) {}

  await createAuditLog('Customer', 'Business Account Created via Autopay', slug, { paymentId: razorpay_payment_id });

  const baseUrl = getReqBaseUrl(req);
  res.json({
    ok: true,
    slug,
    adminUrl: `${baseUrl}/admin?tenant=${slug}`,
    reviewUrl: `${baseUrl}/r/${slug}`,
    message: 'Subscription payment verified! Account created in pending_setup state.'
  });
});

// Razorpay Webhook Event Listener
app.post('/api/razorpay/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!razorpayWebhookSecret || !signature) {
    return res.status(400).json({ error: 'Webhook secret not configured or signature missing' });
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', razorpayWebhookSecret)
      .update(req.body)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const eventData = JSON.parse(req.body.toString());
    console.log(`💳 Razorpay Webhook Event: ${eventData.event}`);

    const payload = eventData.payload;
    if (eventData.event && eventData.event.startsWith('subscription.')) {
      const sub = payload.subscription.entity;
      const subId = sub.id;
      const subStatus = sub.status; // authenticated, active, pending, halted, cancelled, completed

      const allBiz = await fetchAllBusinesses();
      const targetBiz = allBiz.find(b => b.razorpaySubscriptionId === subId);

      if (targetBiz) {
        targetBiz.subscriptionStatus = subStatus;
        if (subStatus === 'halted' || subStatus === 'cancelled') {
          targetBiz.status = 'paused';
        }
        await saveFirestoreBusiness(targetBiz);
        await createAuditLog('Razorpay Webhook', `Subscription State: ${subStatus}`, targetBiz.slug, { event: eventData.event });
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// --- TENANT ADMIN ENDPOINTS ---

app.post('/api/admin/login', async (req, res) => {
  if (!applyRateLimit(req, res, 'admin_login', 10, 60000)) return;

  const { slug, password } = req.body;
  if (!slug || !password) {
    return res.status(400).json({ error: 'Business slug and password are required' });
  }

  const biz = await fetchBusinessBySlug(slug);
  if (!biz || biz.status === 'deleted') {
    return res.status(404).json({ error: 'Business account not found' });
  }

  const storedHash = biz.passwordHash;
  if (!storedHash) {
    return res.status(401).json({ error: 'Account has no valid password hash configured' });
  }

  const isMatch = verifyPassword(password, storedHash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid business password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (86400000 * 7); // 7 days
  tenantSessions.set(token, {
    tenantSlug: biz.slug,
    businessName: biz.name,
    expiresAt
  });

  res.json({ ok: true, token, tenantSlug: biz.slug, businessName: biz.name, expiresAt });
});

app.post('/api/admin/logout', tenantAuth, (req, res) => {
  const token = extractToken(req, 'x-admin-token');
  if (token) tenantSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/admin/stats', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const biz = await fetchBusinessBySlug(tenantSlug);
  const submissions = await fetchTenantReviews(tenantSlug);
  const total = submissions.length;
  const avg = total ? (submissions.reduce((sum, item) => sum + item.rating, 0) / total) : 5.0;

  const ratingCounts = {
    5: submissions.filter(s => s.rating === 5).length,
    4: submissions.filter(s => s.rating === 4).length,
    3: submissions.filter(s => s.rating === 3).length,
    2: submissions.filter(s => s.rating === 2).length,
    1: submissions.filter(s => s.rating === 1).length
  };

  const positiveCount = ratingCounts[5] + ratingCounts[4];
  const privateCount = ratingCounts[3] + ratingCounts[2] + ratingCounts[1];

  const hasPlaceId = Boolean(biz.googlePlaceId && biz.googlePlaceId.trim());
  const googleSyncStatus = biz.googleSyncStatus || (hasPlaceId ? 'pending_sync' : 'not_configured');

  let syncStatusText = 'Pending Setup';
  if (googleSyncStatus === 'synced') {
    syncStatusText = 'Google Business Profile Synced';
  } else if (googleSyncStatus === 'pending_sync' || hasPlaceId) {
    syncStatusText = 'Google Profile Connected • Sync Pending';
  } else {
    syncStatusText = 'Pending Setup: Place ID Not Configured';
  }

  res.json({
    tenantSlug,
    businessName: biz.name,
    category: biz.category || 'General Business',
    status: biz.status || 'pending_setup',
    googlePlaceId: biz.googlePlaceId || '',
    googleSyncStatus,
    googleSyncMessage: syncStatusText,
    googleData: biz.googleData || null,
    total,
    average: total > 0 ? Number(avg.toFixed(1)) : 0,
    ratingCounts,
    positiveCount,
    privateCount,
    healthScore: googleSyncStatus === 'synced' ? (biz.googleData?.healthScore || 98) : (total > 0 ? Math.min(99, 85 + (positiveCount * 2)) : null),
    sentimentPercentage: total > 0 ? Math.round((positiveCount / total) * 100) : null
  });
});

// Paginated Tenant Reviews List
app.get('/api/admin/reviews', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));

  let list = await fetchTenantReviews(tenantSlug);
  const totalReviews = list.length;
  const totalPages = Math.ceil(totalReviews / limit) || 1;

  const startIndex = (page - 1) * limit;
  const paginatedReviews = list.slice(startIndex, startIndex + limit);

  res.json({
    ok: true,
    reviews: paginatedReviews,
    pagination: {
      totalReviews,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
});

app.get('/api/admin/settings', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const biz = await fetchBusinessBySlug(tenantSlug);
  if (!biz) {
    return res.status(404).json({ error: 'Business account not found' });
  }

  res.json({
    slug: biz.slug,
    name: biz.name,
    tagline: biz.tagline || '',
    category: biz.category || 'General Business',
    area: biz.area || '',
    address: biz.address || '',
    phone: biz.phone || '',
    googlePlaceId: biz.googlePlaceId || '',
    googleReviewUrl: formatGoogleReviewUrl(biz.googlePlaceId, biz.googleReviewUrl),
    googleSyncStatus: biz.googleSyncStatus || 'not_configured',
    googleLastSyncedAt: biz.googleLastSyncedAt || null,
    logoUrl: biz.logoUrl || '',
    initials: biz.initials || getInitials(biz.name),
    status: biz.status || 'pending_setup'
  });
});

app.post('/api/admin/settings', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const biz = await fetchBusinessBySlug(tenantSlug);
  if (!biz) {
    return res.status(404).json({ error: 'Business account not found' });
  }

  const { name, tagline, address, phone, adminPassword, logoUrl } = req.body;

  const updated = {
    ...biz,
    name: name !== undefined ? String(name).trim() : biz.name,
    tagline: tagline !== undefined ? String(tagline).trim() : biz.tagline,
    address: address !== undefined ? String(address).trim() : biz.address,
    phone: phone !== undefined ? String(phone).trim() : biz.phone,
    logoUrl: logoUrl !== undefined ? String(logoUrl).trim() : biz.logoUrl,
    initials: getInitials(name || biz.name),
    updatedAt: new Date().toISOString()
  };

  if (adminPassword && String(adminPassword).trim()) {
    updated.passwordHash = hashPassword(String(adminPassword).trim());
    delete updated.adminPassword;
  }

  await saveFirestoreBusiness(updated);
  res.json({ ok: true, message: 'Settings saved successfully.' });
});

// --- MASTER ADMIN ENDPOINTS ---

app.post('/api/master/login', (req, res) => {
  if (!applyRateLimit(req, res, 'master_login', 5, 60000)) return;

  if (!MASTER_PASS) {
    return res.status(503).json({ error: 'Master Admin authentication is not configured. MASTER_PASSWORD environment variable is missing.' });
  }

  const { password } = req.body;
  if (!password || String(password).trim() !== MASTER_PASS) {
    createAuditLog('Unknown IP', 'Master Login Failed', '', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid Master Control Password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 86400000; // 24 hours
  masterSessions.set(token, { expiresAt });

  createAuditLog('Master Admin', 'Master Login Success', '', { ip: req.ip });
  res.json({ ok: true, token, expiresAt });
});

// Master Admin Create New Business (Starts in pending_setup)
app.post('/api/master/businesses', masterAuth, async (req, res) => {
  const { name, category, phone, address, website, logoUrl, tagline, password } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Business Name is required' });
  }
  if (!category || !String(category).trim()) {
    return res.status(400).json({ error: 'Category is required' });
  }
  if (!password || !String(password).trim()) {
    return res.status(400).json({ error: 'Owner password is required' });
  }

  const cleanName = String(name).trim();
  const cleanCategory = String(category).trim();
  const baseSlug = createSlug(cleanName);

  let slug = baseSlug;
  let counter = 1;
  while (await fetchBusinessBySlug(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  const passwordHash = hashPassword(String(password).trim());

  const newBusiness = {
    id: slug,
    slug,
    name: cleanName,
    category: cleanCategory,
    phone: phone ? String(phone).trim() : '',
    address: address ? String(address).trim() : '',
    website: website ? String(website).trim() : '',
    logoUrl: logoUrl ? String(logoUrl).trim() : '',
    initials: getInitials(cleanName),
    tagline: tagline ? String(tagline).trim() : '',
    googlePlaceId: '',
    googleReviewUrl: '',
    status: 'pending_setup',
    setupStatus: 'pending',
    googleSyncStatus: 'pending_sync',
    googleLastSyncedAt: null,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveFirestoreBusiness(newBusiness);
  await createAuditLog('Master Admin', 'Created New Business Account', slug, { name: cleanName, category: cleanCategory });

  const { passwordHash: _, ...safeBiz } = newBusiness;
  res.status(201).json({ ok: true, business: safeBiz });
});

app.get('/api/master/businesses', masterAuth, async (req, res) => {
  try {
    const list = await fetchAllBusinesses();
    const activeList = list.filter(b => b.status !== 'deleted');
    const baseUrl = getReqBaseUrl(req);
    const submissions = getLocalSubmissions();

    const enhancedList = activeList.map(b => {
      const bReviews = submissions.filter(r => (r.tenantSlug || '').toLowerCase().trim() === b.slug);
      const avgRating = bReviews.length ? (bReviews.reduce((acc, r) => acc + (r.rating || 5), 0) / bReviews.length).toFixed(1) : '5.0';

      const { adminPassword, passwordHash, ...safeBiz } = b;
      return {
        ...safeBiz,
        hasPassword: Boolean(adminPassword || passwordHash),
        totalReviews: bReviews.length,
        avgRating,
        reviewUrl: `${baseUrl}/r/${b.slug}`,
        adminUrl: `${baseUrl}/admin?tenant=${b.slug}`
      };
    });

    const activeCount = enhancedList.filter(b => b.status === 'active').length;
    const pendingCount = enhancedList.filter(b => b.status === 'pending_setup').length;
    const pausedCount = enhancedList.filter(b => b.status === 'paused').length;

    res.json({
      totalBusinesses: enhancedList.length,
      monthlyRevenue: enhancedList.length * 199,
      activeCount,
      pendingCount,
      pausedCount,
      businesses: enhancedList
    });
  } catch (err) {
    console.error('Error fetching master businesses:', err.message);
    res.status(500).json({ error: 'Failed to fetch business list' });
  }
});

app.patch('/api/master/businesses/:slug', masterAuth, async (req, res) => {
  const { slug } = req.params;
  const { googlePlaceId, status, tagline, address, adminPassword, category, logoUrl } = req.body;

  const current = await fetchBusinessBySlug(slug);
  if (!current) {
    return res.status(404).json({ error: 'Business account not found' });
  }

  let finalPlaceId = current.googlePlaceId || '';
  let finalReviewUrl = current.googleReviewUrl || '';

  let isVerified = false;
  if (googlePlaceId !== undefined) {
    const rawInput = String(googlePlaceId).trim();
    if (rawInput) {
      const validation = validateAndExtractPlaceId(rawInput);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Google Business Profile could not be verified. Please check the Place ID and try again.' });
      }
      finalPlaceId = validation.placeId;
      finalReviewUrl = validation.reviewUrl;
      isVerified = true;
    } else {
      finalPlaceId = '';
      finalReviewUrl = '';
      isVerified = false;
    }
  }

  let targetStatus = status || current.status || 'pending_setup';

  if (targetStatus === 'active' && !finalPlaceId) {
    return res.status(400).json({ error: 'Google Business Profile could not be verified. Please check the Place ID and try again.' });
  }

  let syncStatus = current.googleSyncStatus || 'pending_sync';
  let setupStatus = current.setupStatus || 'pending';
  let googleLastSyncedAt = current.googleLastSyncedAt || null;

  if (finalPlaceId && isVerified) {
    targetStatus = 'active';
    setupStatus = 'completed';
    syncStatus = 'synced';
    googleLastSyncedAt = new Date().toISOString();
  }

  let passwordHash = current.passwordHash || null;
  if (adminPassword !== undefined && String(adminPassword).trim() !== '') {
    passwordHash = hashPassword(String(adminPassword).trim());
  }

  const updated = {
    ...current,
    googlePlaceId: finalPlaceId,
    googleReviewUrl: finalReviewUrl,
    passwordHash,
    category: category !== undefined && String(category).trim() !== '' ? String(category).trim() : (current.category || 'General Business'),
    logoUrl: logoUrl !== undefined ? String(logoUrl).trim() : (current.logoUrl || ''),
    initials: getInitials(current.name),
    status: targetStatus,
    setupStatus,
    googleSyncStatus: syncStatus,
    googleLastSyncedAt,
    tagline: tagline !== undefined ? String(tagline).trim() : (current.tagline || ''),
    address: address !== undefined ? String(address).trim() : (current.address || ''),
    updatedAt: new Date().toISOString()
  };

  delete updated.adminPassword; // Remove plaintext password key

  await saveFirestoreBusiness(updated);
  await createAuditLog('Master Admin', 'Updated Business Details', slug, { googlePlaceId: finalPlaceId, status: targetStatus, category: updated.category });

  const { passwordHash: _, ...safeUpdated } = updated;
  res.json({ ok: true, business: safeUpdated });
});

// Soft Delete Business Endpoint
app.delete('/api/master/businesses/:slug', masterAuth, async (req, res) => {
  const { slug } = req.params;
  const current = await fetchBusinessBySlug(slug);
  if (!current) {
    return res.status(404).json({ error: 'Business account not found' });
  }

  const updated = {
    ...current,
    status: 'deleted',
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveFirestoreBusiness(updated);
  await createAuditLog('Master Admin', 'Business Soft Deleted', slug, { name: current.name });

  res.json({ ok: true, message: `Business '${slug}' soft deleted successfully.` });
});

app.post('/api/master/toggle-status', masterAuth, async (req, res) => {
  const { slug, status } = req.body;
  if (!slug || !status) {
    return res.status(400).json({ error: 'Slug and status are required' });
  }

  const current = await fetchBusinessBySlug(slug);
  if (!current) {
    return res.status(404).json({ error: 'Business account not found' });
  }

  if (status === 'active' && !current.googlePlaceId) {
    return res.status(400).json({ error: 'Cannot activate business without a Google Place ID configured.' });
  }

  const updated = {
    ...current,
    status,
    setupStatus: status === 'active' ? 'completed' : 'pending',
    updatedAt: new Date().toISOString()
  };

  await saveFirestoreBusiness(updated);
  await createAuditLog('Master Admin', `Toggled Business Status: ${status}`, slug);

  res.json({ ok: true, business: updated });
});

app.get('/api/master/payments', masterAuth, async (req, res) => {
  try {
    const colRef = collection(db, 'payments');
    const snapshot = await getDocs(colRef);
    const list = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() });
    });
    res.json(list.sort((a, b) => new Date(b.date) - new Date(a.date)));
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/master/audit-logs', masterAuth, async (req, res) => {
  try {
    const colRef = collection(db, 'audit_logs');
    const snapshot = await getDocs(colRef);
    const list = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() });
    });
    res.json(list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
  } catch (err) {
    res.json([]);
  }
});

// --- GROQ AI DYNAMIC REVIEW ASSISTANCE SYSTEM ---
const suggestionsCache = new Map();

app.get(['/api/reviews/suggestions', '/api/groq/presets'], async (req, res) => {
  if (!applyRateLimit(req, res, 'groq_suggestions', 20, 60000)) return;

  const tenantSlug = String(req.query.tenant || req.query.slug || '').toLowerCase().trim();
  if (!tenantSlug) {
    return res.status(400).json({ error: 'Tenant slug is required' });
  }

  const biz = await fetchBusinessBySlug(tenantSlug);
  if (!biz || biz.status === 'deleted') {
    return res.status(404).json({ error: 'Business Not Found', slug: tenantSlug });
  }

  if (biz.status === 'pending_setup') {
    return res.status(403).json({
      error: 'Business setup is pending. Review suggestions are unavailable until verified by Master Admin.'
    });
  }

  const category = biz.category || 'General Business';
  const bizName = biz.name || 'Our Business';

  const cacheKey = `suggestions:${biz.id || tenantSlug}:${category.toLowerCase()}`;
  const now = Date.now();
  if (suggestionsCache.has(cacheKey)) {
    const cached = suggestionsCache.get(cacheKey);
    if (now - cached.timestamp < 24 * 60 * 60 * 1000) {
      return res.json(cached.data);
    }
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return res.status(503).json({
      ok: false,
      error: 'AI review generation temporarily unavailable. Please try again.'
    });
  }

  try {
    const prompt = `You are an expert review helper for local businesses.
Generate 5-star review templates for the following business:
- Business Name: "${bizName}"
- Industry / Category: "${category}"

Return ONLY valid JSON matching this exact structure:
{
  "ok": true,
  "businessName": "${bizName}",
  "category": "${category}",
  "categories": [
    { "id": "cat_1", "name": "Service Quality", "icon": "⭐", "desc": "Top tier quality and care" },
    { "id": "cat_2", "name": "Customer Care", "icon": "🤝", "desc": "Friendly & attentive staff" },
    { "id": "cat_3", "name": "Overall Experience", "icon": "🏆", "desc": "Prompt & reliable service" }
  ],
  "presets": [
    { "id": 1, "title": "Exceptional Service!", "tag": "Top Rated", "text": "Extremely satisfied with the service provided by ${bizName}. Highly professional and recommended!" },
    { "id": 2, "title": "Highly Professional", "tag": "Verified", "text": "Outstanding experience at ${bizName}. Quick response, helpful staff, and top notch quality." },
    { "id": 3, "title": "Great Experience", "tag": "5 Stars", "text": "Fantastic experience from start to finish. ${bizName} delivered beyond expectations!" },
    { "id": 4, "title": "Prompt & Reliable", "tag": "Recommended", "text": "Very reliable and efficient! I am very happy with ${bizName} and will definitely use their services again." }
  ]
}
Do NOT include markdown wrapping or extra commentary. Return raw JSON.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqRes.ok) {
      throw new Error(`Groq API returned HTTP ${groqRes.status}`);
    }

    const groqData = await groqRes.json();
    const contentStr = groqData.choices[0]?.message?.content;
    const parsed = JSON.parse(contentStr);
    parsed.ok = true;

    suggestionsCache.set(cacheKey, { timestamp: now, data: parsed });
    res.json(parsed);
  } catch (err) {
    console.warn(`Groq API notice for ${bizName}:`, err.message);
    res.status(503).json({
      ok: false,
      error: 'AI review generation temporarily unavailable. Please try again.'
    });
  }
});

app.post('/api/master/analyze-gmb', masterAuth, async (req, res) => {
  if (!applyRateLimit(req, res, 'groq_gmb_analysis', 20, 60000)) return;

  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'Slug is required' });

  const biz = await fetchBusinessBySlug(slug);
  if (!biz) return res.status(404).json({ error: 'Business account not found' });

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    const analysis = `Analysis for ${biz.name} (${biz.category}): Profile active with valid Google Place ID (${biz.googlePlaceId || 'Not Configured'}). Optimization suggested: gather 15+ new 5-star reviews to boost local pack ranking.`;
    biz.aiAnalysis = analysis;
    await saveFirestoreBusiness(biz);
    return res.json({ ok: true, aiAnalysis: analysis });
  }

  try {
    const prompt = `Analyze this Google My Business Profile:
- Business Name: ${biz.name}
- Category: ${biz.category || 'General Business'}
- Place ID: ${biz.googlePlaceId || 'Not set'}
- Status: ${biz.status}

Provide 3 actionable tips in 2-3 concise sentences to improve Google Search & Maps local ranking for this specific business category.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6
      })
    });

    const data = await groqRes.json();
    const aiAnalysis = data.choices[0]?.message?.content || 'GMB Profile is optimized.';

    biz.aiAnalysis = aiAnalysis;
    await saveFirestoreBusiness(biz);
    res.json({ ok: true, aiAnalysis });
  } catch (e) {
    res.status(500).json({ error: 'Failed to analyze GMB profile' });
  }
});

// Single Page Application Frontend Routing Catch-all
app.get('/r/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/master', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'super-admin.html'));
});

// Start Server and Listen on Port
const server = app.listen(PORT, () => {
  console.log(`✨ Multi-Tenant GMB Review Booster running on port ${PORT}`);
  console.log(`🔑 Master Control Portal available at /master`);
});

// Graceful Shutdown for AWS EC2 Node process
function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Gracefully shutting down server...`);
  server.close(() => {
    console.log('✅ HTTP server closed. Process terminated cleanly.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ Timeout waiting for connections to close. Force shutting down.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
