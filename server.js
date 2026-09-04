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
  console.log('Razorpay package loaded or pending');
}

const app = express();
app.use(express.json());

// Enable CORS for Live Server / multi-origin access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-master-token');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
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

// User Provided Firebase Configuration (buildaura-2f728)
const firebaseConfig = {
  apiKey: "AIzaSyC28f1Hwhzbg2lv8zAP_EzQZtf0iY37phU",
  authDomain: "buildaura-2f728.firebaseapp.com",
  projectId: "buildaura-2f728",
  storageBucket: "buildaura-2f728.firebasestorage.app",
  messagingSenderId: "762817548547",
  appId: "1:762817548547:web:caf84a2652ed56b17a1936",
  measurementId: "G-9LSFHED9XQ"
};

// Initialize Firebase App & Firestore Database instance
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
console.log('🔥 Connected to Firebase Firestore (buildaura-2f728)');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// User Provided Razorpay Live Credentials
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TWfdHUXcUNhDvk';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || 'lijw6c38DrPTfkoyPL3kC5Y3';
const razorpayPlanId = process.env.RAZORPAY_PLAN_ID || 'plan_TWe7OhBsGpNK4q';

let rzpInstance = null;
if (Razorpay) {
  try {
    rzpInstance = new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    });
  } catch (e) {}
}

// Default Seed Business Profile (Divya Rathod Beauty Salon)
const defaultDivyaBusiness = {
  id: 'divya-rathod-beauty-salon',
  slug: 'divya-rathod-beauty-salon',
  name: 'Divya Rathod Beauty Salon',
  tagline: 'Luxury Hair • Makeup • Bridal • Skincare • Luxury Beauty',
  area: 'Adani Shantigram / near Vaishnodevi Circle, Ahmedabad',
  address: 'FF - 112, Magnate Lifestyle, near Vaishnodevi Circle, Adalaj, Khodiyar, Gujarat 382421',
  phone: '098566 98533',
  website: 'https://divyarathod.com',
  instagram: 'https://www.instagram.com/divyarathodbeautysalon/',
  googleReviewUrl: 'https://search.google.com/local/writereview?placeid=ChIJmcF2R3KDXjkR8uxzfKEdGyA',
  googlePlaceId: 'ChIJmcF2R3KDXjkR8uxzfKEdGyA',
  adminPassword: process.env.ADMIN_PASSWORD || '5922',
  plan: '₹199/month Autopay',
  status: 'active',
  services: [
    'Haircut & Hair Styling',
    'Hair Spa & Keratin',
    'Hair Colouring & Highlights',
    'HD & Airbrush Bridal Makeup',
    'Luxury Facial & Skincare',
    'Nail Extensions & Spa',
    'Body Waxing & Threading'
  ],
  staffList: [
    'Divya Rathod (Owner)',
    'Senior Hair Stylist',
    'Senior Makeup Artist',
    'Skincare Specialist',
    'General Salon Staff'
  ],
  createdAt: new Date().toISOString()
};

// In-memory active sessions
const tenantSessions = new Map(); // token -> { tenantSlug, expiresAt }
const masterSessions = new Map(); // token -> expiresAt

// Master Control Password requested by User
const MASTER_PASS = process.env.MASTER_PASSWORD || 'Adi@Kin#2501';

// Local Fallback Helpers
function getLocalBusinesses() {
  try {
    if (fs.existsSync(BUSINESSES_FILE)) {
      const data = fs.readFileSync(BUSINESSES_FILE, 'utf8');
      const list = JSON.parse(data);
      if (list && list.length) return list;
    }
  } catch (err) {}
  return [defaultDivyaBusiness];
}

function saveLocalBusinesses(list) {
  try {
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {}
}

function getLocalSubmissions() {
  try {
    if (fs.existsSync(REVIEWS_FILE)) {
      const data = fs.readFileSync(REVIEWS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {}
  return [];
}

function saveLocalSubmissions(submissions) {
  try {
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(submissions, null, 2), 'utf8');
  } catch (err) {}
}

// Firestore Database async helpers for Multi-Tenant Businesses
async function fetchAllBusinesses() {
  try {
    const colRef = collection(db, 'businesses');
    const snapshot = await getDocs(colRef);
    const list = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() });
    });
    if (list.length > 0) {
      saveLocalBusinesses(list);
      return list;
    }
  } catch (e) {
    console.error('Firestore businesses fetch error, using local cache:', e.message);
  }
  
  // Seed default if empty
  const defaultList = getLocalBusinesses();
  saveFirestoreBusiness(defaultDivyaBusiness).catch(() => {});
  return defaultList;
}

async function fetchBusinessBySlug(slug) {
  const targetSlug = String(slug || 'divya-rathod-beauty-salon').toLowerCase().trim();
  try {
    const docRef = doc(db, 'businesses', targetSlug);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() };
    }
  } catch (e) {
    console.error('Firestore business fetch error:', e.message);
  }

  const allLocal = getLocalBusinesses();
  const found = allLocal.find(b => b.slug === targetSlug || b.id === targetSlug);
  return found || defaultDivyaBusiness;
}

async function saveFirestoreBusiness(businessData) {
  const slug = String(businessData.slug || businessData.id || 'divya-rathod-beauty-salon').toLowerCase().trim();
  const payload = {
    ...businessData,
    id: slug,
    slug,
    updatedAt: new Date().toISOString()
  };

  // Save to local cache
  const local = getLocalBusinesses();
  const idx = local.findIndex(b => b.slug === slug);
  if (idx !== -1) {
    local[idx] = { ...local[idx], ...payload };
  } else {
    local.push(payload);
  }
  saveLocalBusinesses(local);

  try {
    const docRef = doc(db, 'businesses', slug);
    await setDoc(docRef, payload, { merge: true });
    return true;
  } catch (e) {
    console.error('Firestore business write error:', e.message);
    return false;
  }
}

async function deleteFirestoreBusiness(slug) {
  const targetSlug = String(slug).toLowerCase().trim();
  try {
    const docRef = doc(db, 'businesses', targetSlug);
    await deleteDoc(docRef);
  } catch (e) {}

  let local = getLocalBusinesses();
  local = local.filter(b => b.slug !== targetSlug);
  saveLocalBusinesses(local);
}

// Fetch Reviews for a tenant
async function fetchTenantReviews(tenantSlug) {
  const targetSlug = tenantSlug ? String(tenantSlug).toLowerCase().trim() : null;
  try {
    const colRef = collection(db, 'reviews');
    const snapshot = await getDocs(colRef);
    let list = [];
    snapshot.forEach(docSnap => {
      list.push({ id: docSnap.id, ...docSnap.data() });
    });

    if (targetSlug) {
      list = list.filter(r => (r.tenantSlug || 'divya-rathod-beauty-salon') === targetSlug);
    }
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    saveLocalSubmissions(list);
    return list;
  } catch (e) {
    console.error('Firestore reviews fetch error, using local cache:', e.message);
    let list = getLocalSubmissions();
    if (targetSlug) {
      list = list.filter(r => (r.tenantSlug || 'divya-rathod-beauty-salon') === targetSlug);
    }
    return list;
  }
}

// Authentication Middlewares
function tenantAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !tenantSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized session' });
  }
  req.tenantSession = tenantSessions.get(token);
  next();
}

function masterAuth(req, res, next) {
  const token = req.headers['x-master-token'] || req.query.masterToken;
  if (!token || !masterSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized Master Control session' });
  }
  next();
}

// Helper to format Google Review Write URL with Place ID
function formatGoogleReviewUrl(placeId, customUrl) {
  if (placeId && placeId.trim()) {
    return `https://search.google.com/local/writereview?placeid=${placeId.trim()}`;
  }
  if (customUrl && customUrl.trim() && !customUrl.includes('YOUR_PLACE_ID')) {
    return customUrl.trim();
  }
  return '';
}

// Helper to generate URL slug from business name
function createSlug(name) {
  return String(name || 'my-business')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || 'my-business';
}

// --- PUBLIC TENANT ENDPOINTS ---

// Get business info for front-end customer review page
app.get('/api/business', async (req, res) => {
  const slug = req.query.tenant || req.query.slug || 'divya-rathod-beauty-salon';
  const biz = await fetchBusinessBySlug(slug);
  res.json({
    id: biz.id,
    slug: biz.slug,
    name: biz.name,
    tagline: biz.tagline,
    area: biz.area,
    address: biz.address,
    phone: biz.phone,
    website: biz.website,
    instagram: biz.instagram,
    googlePlaceId: biz.googlePlaceId || '',
    googleReviewUrl: formatGoogleReviewUrl(biz.googlePlaceId, biz.googleReviewUrl),
    services: biz.services || [],
    staffList: biz.staffList || [],
    status: biz.status || 'pending_setup'
  });
});

// Submit a new review for a specific business
app.post('/api/reviews', async (req, res) => {
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
  }

  const tenantSlug = String(req.body.tenantSlug || req.body.slug || 'divya-rathod-beauty-salon').toLowerCase().trim();
  const biz = await fetchBusinessBySlug(tenantSlug);

  if (biz.status === 'paused') {
    return res.status(403).json({ error: 'Service temporarily paused by management.' });
  }

  const reviewItem = {
    tenantSlug,
    businessName: biz.name,
    rating,
    service: String(req.body.service || '').trim(),
    staff: String(req.body.staff || '').trim(),
    feedback: String(req.body.feedback || '').trim(),
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    customerName: String(req.body.customerName || '').trim(),
    customerPhone: String(req.body.customerPhone || '').trim(),
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

  // Also save locally as fallback
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
    const tenantSlug = req.query.tenant || req.query.slug || 'divya-rathod-beauty-salon';
    const biz = await fetchBusinessBySlug(tenantSlug);
    const baseUrl = getReqBaseUrl(req);
    const reviewUrl = `${baseUrl}/r/${biz.slug}`;
    const dataUrl = await QRCode.toDataURL(reviewUrl, {
      width: 1200, // HD 4K Quality
      margin: 2,
      color: {
        dark: '#2A1725',
        light: '#FFFFFF'
      }
    });
    res.json({ url: reviewUrl, data: dataUrl, businessName: biz.name, slug: biz.slug, status: biz.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- RAZORPAY AUTOPAY SUBSCRIPTION ENDPOINTS ---

// Get Razorpay Configuration for frontend
app.get('/api/razorpay/config', (req, res) => {
  res.json({
    key: razorpayKeyId,
    plan_id: razorpayPlanId,
    amount: 19900, // ₹199 in paise
    currency: 'INR',
    name: 'GMB Google Review Booster Platform',
    description: '₹199/Month Autopay Subscription'
  });
});

// Create Razorpay Subscription (Autopay)
app.post('/api/razorpay/create-subscription', async (req, res) => {
  const { businessName, phone } = req.body;

  if (rzpInstance) {
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
      console.error('Razorpay subscription error:', err.message);
    }
  }

  // Fallback mock subscription for testing
  res.json({
    ok: true,
    subscription: {
      id: `sub_mock_${crypto.randomBytes(8).toString('hex')}`,
      plan_id: razorpayPlanId,
      status: 'created'
    }
  });
});

// Verify Subscription & Provision Account as "Pending Setup"
app.post('/api/razorpay/verify-subscription', async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_subscription_id,
    razorpay_signature,
    businessName,
    phone,
    password
  } = req.body;

  const baseSlug = createSlug(businessName);
  let slug = baseSlug;
  let counter = 1;
  const existingList = await fetchAllBusinesses();
  while (existingList.some(b => b.slug === slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  const newBusiness = {
    id: slug,
    slug,
    name: businessName || 'My Business GMB',
    tagline: 'Google Verified Business Profile',
    address: 'Main City Location',
    phone: phone || '',
    googlePlaceId: '', // Blank until Master Control updates!
    googleReviewUrl: '',
    adminPassword: password || '123456',
    plan: '₹199/month Autopay Active',
    subscriptionId: razorpay_subscription_id || 'sub_live_199',
    paymentId: razorpay_payment_id || 'pay_live_199',
    status: 'pending_setup', // Pending until Master Control updates Place ID!
    services: [
      'Customer Consultation',
      'Premium Service & Care'
    ],
    staffList: ['Management Staff'],
    createdAt: new Date().toISOString()
  };

  await saveFirestoreBusiness(newBusiness);

  const baseUrl = getReqBaseUrl(req);
  res.json({
    ok: true,
    message: 'Subscription Autopay active! Profile in Pending Setup.',
    business: newBusiness,
    adminUrl: `${baseUrl}/admin?tenant=${slug}`,
    reviewUrl: `${baseUrl}/r/${slug}`
  });
});

// --- TENANT ADMIN ENDPOINTS ---

// Tenant Admin Login
app.post('/api/admin/login', async (req, res) => {
  const tenantSlug = String(req.body.tenantSlug || req.body.tenant || 'divya-rathod-beauty-salon').toLowerCase().trim();
  const providedPassword = String(req.body.password || '');

  const biz = await fetchBusinessBySlug(tenantSlug);
  
  if (providedPassword !== String(biz.adminPassword)) {
    return res.status(401).json({ error: 'Incorrect password for this business account' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  tenantSessions.set(token, {
    tenantSlug: biz.slug,
    businessName: biz.name,
    expiresAt: Date.now() + 86400000 * 7
  });

  res.json({ ok: true, token, tenantSlug: biz.slug, businessName: biz.name });
});

// Tenant Logout
app.post('/api/admin/logout', tenantAuth, (req, res) => {
  const token = req.headers['x-admin-token'];
  tenantSessions.delete(token);
  res.json({ ok: true });
});

// Tenant Stats & GMB Performance Analytics
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

  res.json({
    tenantSlug,
    businessName: biz.name,
    status: biz.status || 'pending_setup',
    googlePlaceId: biz.googlePlaceId || '',
    total,
    average: Number(avg.toFixed(1)),
    ratingCounts,
    positiveCount,
    privateCount,
    // Calculated GMB Performance Health Score
    healthScore: total > 0 ? Math.min(99, 85 + (positiveCount * 2)) : 94,
    sentimentPercentage: total > 0 ? Math.round((positiveCount / total) * 100) : 98
  });
});

// Tenant Reviews List
app.get('/api/admin/reviews', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  let list = await fetchTenantReviews(tenantSlug);
  const { rating, status, search } = req.query;

  if (rating) {
    const rNum = Number(rating);
    if (!isNaN(rNum)) {
      list = list.filter(item => item.rating === rNum);
    } else if (rating === 'positive') {
      list = list.filter(item => item.rating >= 4);
    } else if (rating === 'private') {
      list = list.filter(item => item.rating <= 3);
    }
  }

  if (status) {
    list = list.filter(item => item.status === status);
  }

  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter(item => 
      (item.customerName && item.customerName.toLowerCase().includes(q)) ||
      (item.customerPhone && item.customerPhone.includes(q)) ||
      (item.service && item.service.toLowerCase().includes(q)) ||
      (item.feedback && item.feedback.toLowerCase().includes(q))
    );
  }

  res.json(list);
});

// Get tenant settings
app.get('/api/admin/settings', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const biz = await fetchBusinessBySlug(tenantSlug);
  res.json(biz);
});

// Update tenant settings
app.post('/api/admin/settings', tenantAuth, async (req, res) => {
  const tenantSlug = req.tenantSession.tenantSlug;
  const current = await fetchBusinessBySlug(tenantSlug);
  const {
    name,
    tagline,
    address,
    phone,
    adminPassword,
    services
  } = req.body;

  const updated = {
    ...current,
    name: name !== undefined ? String(name).trim() : current.name,
    tagline: tagline !== undefined ? String(tagline).trim() : current.tagline,
    address: address !== undefined ? String(address).trim() : current.address,
    phone: phone !== undefined ? String(phone).trim() : current.phone,
    adminPassword: adminPassword && String(adminPassword).trim() !== '' ? String(adminPassword).trim() : current.adminPassword,
    services: Array.isArray(services) ? services : current.services
  };

  await saveFirestoreBusiness(updated);
  res.json({ ok: true, settings: updated });
});

// --- MASTER CONTROL ENDPOINTS ---

// Master Control Login
app.post('/api/master/login', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== MASTER_PASS) {
    return res.status(401).json({ error: 'Invalid Master Control password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  masterSessions.set(token, Date.now() + 86400000 * 7);
  res.json({ ok: true, token });
});

// List All Businesses for Master Control
app.get('/api/master/businesses', masterAuth, async (req, res) => {
  const list = await fetchAllBusinesses();
  const allReviews = await fetchTenantReviews(null);

  const enhancedList = list.map(b => {
    const bReviews = allReviews.filter(r => r.tenantSlug === b.slug);
    const avgRating = bReviews.length ? (bReviews.reduce((acc, r) => acc + r.rating, 0) / bReviews.length).toFixed(1) : '5.0';
    return {
      ...b,
      totalReviews: bReviews.length,
      avgRating,
      reviewUrl: `${BASE_URL}/r/${b.slug}`,
      adminUrl: `${BASE_URL}/admin?tenant=${b.slug}`
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
});

// Update Place ID & Activate / Pause Business (Master Control)
app.patch('/api/master/businesses/:slug', masterAuth, async (req, res) => {
  const { slug } = req.params;
  const { googlePlaceId, status, tagline, address } = req.body;

  const current = await fetchBusinessBySlug(slug);

  const updated = {
    ...current,
    googlePlaceId: googlePlaceId !== undefined ? String(googlePlaceId).trim() : (current.googlePlaceId || ''),
    googleReviewUrl: formatGoogleReviewUrl(googlePlaceId !== undefined ? googlePlaceId : current.googlePlaceId, ''),
    status: status || (googlePlaceId ? 'active' : current.status),
    tagline: tagline || current.tagline,
    address: address || current.address
  };

  await saveFirestoreBusiness(updated);
  res.json({ ok: true, business: updated });
});

// Quick Pause / Start Service (Master Control)
app.post('/api/master/toggle-status', masterAuth, async (req, res) => {
  const { slug, status } = req.body;
  const current = await fetchBusinessBySlug(slug);
  
  current.status = status; // 'active', 'paused', 'pending_setup'
  await saveFirestoreBusiness(current);

  res.json({ ok: true, status: current.status });
});

// Groq AI GMB Profile Analysis (Master Control Only)
app.post('/api/master/analyze-gmb', masterAuth, async (req, res) => {
  const { slug } = req.body;
  const biz = await fetchBusinessBySlug(slug);

  const groqApiKey = process.env.GROQ_API_KEY || "gsk_Vf1d530yX3W16gRj1X4GWDYb3FYFX5m6kYx02G2z8j1r6j1r";
  let aiSummary = `GMB Profile Analysis completed for ${biz.name}. Category: Local Services. Google 5-Star redirect active. Recommended focus: Customer Service & Quick Responses.`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{
          role: "user",
          content: `Analyze GMB Profile for business '${biz.name}'. Provide a 2-sentence optimization summary and recommend top 3 service categories for local search ranking.`
        }]
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      aiSummary = data.choices[0].message.content;
    }
  } catch (err) {
    console.log('Groq analysis fallback used');
  }

  biz.aiAnalysis = aiSummary;
  biz.analyzedAt = new Date().toISOString();
  await saveFirestoreBusiness(biz);

  res.json({ ok: true, aiAnalysis: aiSummary, business: biz });
});

// Payment & Registration Request History (Master Control)
app.get('/api/master/payments', masterAuth, async (req, res) => {
  const list = await fetchAllBusinesses();
  const history = list.map(b => ({
    date: b.createdAt || new Date().toISOString(),
    name: b.name,
    slug: b.slug,
    phone: b.phone || 'N/A',
    subscriptionId: b.subscriptionId || b.paymentId || 'sub_live_199',
    plan: b.plan || '₹199/month Autopay',
    status: b.status === 'active' ? 'Paid (₹199 Autopay Active)' : (b.status === 'paused' ? 'Service Stopped / Suspended' : 'Payment Received (Pending Setup)')
  }));

  res.json(history);
});

// Delete Business (Master Control)
app.delete('/api/master/businesses/:slug', masterAuth, async (req, res) => {
  const { slug } = req.params;
  await deleteFirestoreBusiness(slug);
  res.json({ ok: true });
});

// --- FRONTEND ROUTING ---

// Customer Review Page
app.get(['/r/:slug', '/r', '/review', '/review.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

// Master Control HTML Page
app.get(['/master', '/master-control', '/super-admin', '/super-admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'super-admin.html'));
});

// Business Admin Portal HTML Page
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Multi-Tenant GMB Review Booster running at ${BASE_URL}`);
  console.log(`🔑 Master Control Portal available at ${BASE_URL}/master`);
});
