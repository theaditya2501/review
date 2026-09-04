```js
/**
 * FIRESTORE PRODUCTION DATA MIGRATION
 *
 * What this script does:
 * 1. Creates a JSON backup of affected Firestore business documents.
 * 2. Converts plaintext owner passwords to scrypt hashes.
 * 3. Deletes adminPassword from Firestore.
 * 4. Removes Sunrise Cafe's incorrect Divya Place ID.
 * 5. Moves Sunrise and unverified Thushr to pending_setup.
 * 6. Keeps Divya active.
 * 7. Optionally updates non-secret Razorpay configuration.
 * 8. Verifies the final Firestore state.
 *
 * IMPORTANT:
 * - Uses Firebase Admin SDK.
 * - Does NOT hardcode Firebase credentials.
 * - Does NOT store Razorpay secrets in Firestore.
 * - Passwords are supplied through environment variables.
 *
 * Required:
 *   npm install firebase-admin
 *
 * Authentication:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *
 * Passwords:
 *   DIVYA_PASSWORD=...
 *   SUNRISE_PASSWORD=...
 *   THUSHR_PASSWORD=...
 *
 * Optional Razorpay public configuration:
 *   RAZORPAY_KEY_ID=rzp_...
 *   RAZORPAY_PLAN_ID=plan_...
 *
 * Secret values MUST remain in environment variables:
 *   RAZORPAY_KEY_SECRET
 *   RAZORPAY_WEBHOOK_SECRET
 */

'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'buildaura-2f728';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    '\nERROR: GOOGLE_APPLICATION_CREDENTIALS is not configured.\n' +
    'Set it to your Firebase service-account JSON file before running this script.\n'
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID
});

const db = admin.firestore();

const businessesCollection = db.collection('businesses');

function hashPassword(password) {
  if (!password) {
    throw new Error('Password is missing.');
  }

  const salt = crypto.randomBytes(16).toString('hex');

  const derivedKey = crypto.scryptSync(
    String(password),
    salt,
    64
  );

  return `${ salt }:${ derivedKey.toString('hex') } `;
}

function timestamp() {
  return new Date().toISOString();
}

function safeBackupName() {
  return `firestore - businesses - backup - ${ Date.now() }.json`;
}

async function readBusiness(slug) {
  const ref = businessesCollection.doc(slug);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error(`Business not found: ${ slug } `);
  }

  return {
    ref,
    data: snap.data()
  };
}

async function backupBusinesses(slugs) {
  const backup = {
    projectId: PROJECT_ID,
    createdAt: timestamp(),
    businesses: {}
  };

  for (const slug of slugs) {
    const { data } = await readBusiness(slug);

    // Backup the complete document internally.
    backup.businesses[slug] = data;
  }

  const backupDir = path.join(__dirname, 'data', 'backups');

  fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(
    backupDir,
    safeBackupName()
  );

  fs.writeFileSync(
    backupPath,
    JSON.stringify(backup, null, 2),
    'utf8'
  );

  return backupPath;
}

function requirePassword(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${ name } is missing.Refusing to create or overwrite a password hash.`
    );
  }

  return value;
}

async function migrateDivya() {
  const { ref, data } =
    await readBusiness('divya-rathod-beauty-salon');

  const password =
    process.env.DIVYA_PASSWORD ||
    data.adminPassword;

  if (!data.passwordHash && !password) {
    throw new Error(
      'Divya has neither passwordHash nor adminPassword.'
    );
  }

  const passwordHash =
    data.passwordHash || hashPassword(password);

  await ref.set(
    {
      passwordHash,

      // Remove plaintext password.
      adminPassword: admin.firestore.FieldValue.delete(),

      status: 'active',
      setupStatus: 'completed',

      updatedAt: timestamp()
    },
    { merge: true }
  );

  return {
    slug: 'divya-rathod-beauty-salon',
    status: 'active',
    setupStatus: 'completed',
    passwordHashCreated: !data.passwordHash
  };
}

async function migrateSunrise() {
  const { ref, data } =
    await readBusiness('sunrise-cafe');

  const password =
    process.env.SUNRISE_PASSWORD ||
    data.adminPassword;

  if (!data.passwordHash && !password) {
    throw new Error(
      'Sunrise Cafe has neither passwordHash nor adminPassword.'
    );
  }

  const passwordHash =
    data.passwordHash || hashPassword(password);

  await ref.set(
    {
      passwordHash,

      // Remove plaintext password.
      adminPassword: admin.firestore.FieldValue.delete(),

      // CRITICAL:
      // Sunrise must not inherit Divya's Place ID.
      googlePlaceId: '',
      googleReviewUrl: '',

      googleSyncStatus: 'pending_sync',
      googleLastSyncedAt: null,
      googleData: null,

      setupStatus: 'pending',
      status: 'pending_setup',

      updatedAt: timestamp()
    },
    { merge: true }
  );

  return {
    slug: 'sunrise-cafe',
    status: 'pending_setup',
    setupStatus: 'pending',
    googlePlaceId: '',
    passwordHashCreated: !data.passwordHash
  };
}

async function migrateThushr() {
  const { ref, data } =
    await readBusiness('thushr');

  const password =
    process.env.THUSHR_PASSWORD ||
    data.adminPassword;

  if (!data.passwordHash && !password) {
    throw new Error(
      'Thushr has neither passwordHash nor adminPassword.'
    );
  }

  const passwordHash =
    data.passwordHash || hashPassword(password);

  await ref.set(
    {
      passwordHash,

      // Remove plaintext password.
      adminPassword: admin.firestore.FieldValue.delete(),

      category: 'Gas Distribution & Delivery',

      // Do NOT claim Google verification until the Place ID
      // has actually been verified against Thushr.
      status: 'pending_setup',
      setupStatus: 'pending',

      googleSyncStatus: 'pending_sync',
      googleLastSyncedAt: null,
      googleData: null,

      updatedAt: timestamp()
    },
    { merge: true }
  );

  return {
    slug: 'thushr',
    status: 'pending_setup',
    setupStatus: 'pending',
    category: 'Gas Distribution & Delivery',
    passwordHashCreated: !data.passwordHash
  };
}

/**
 * Updates ONLY non-secret Razorpay configuration.
 *
 * Safe to store:
 *   razorpayKeyId
 *   razorpayPlanId
 *
 * NEVER store:
 *   razorpayKeySecret
 *   razorpayWebhookSecret
 */
async function updateRazorpayPublicConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const planId = process.env.RAZORPAY_PLAN_ID;

  if (!keyId && !planId) {
    console.log(
      '\nRazorpay public configuration not supplied. Skipping Firestore update.'
    );

    return {
      updated: false
    };
  }

  const settingsRef = db.collection('settings').doc('razorpay');

  const update = {
    updatedAt: timestamp()
  };

  if (keyId) {
    update.razorpayKeyId = keyId;
  }

  if (planId) {
    update.razorpayPlanId = planId;
  }

  await settingsRef.set(update, { merge: true });

  return {
    updated: true,
    keyIdUpdated: Boolean(keyId),
    planIdUpdated: Boolean(planId)
  };
}

async function verifyBusiness(slug) {
  const { data } = await readBusiness(slug);

  return {
    id: slug,
    name: data.name,
    category: data.category || null,

    status: data.status || null,
    setupStatus: data.setupStatus || null,

    googlePlaceId:
      data.googlePlaceId || '',

    googleReviewUrl:
      data.googleReviewUrl || '',

    googleSyncStatus:
      data.googleSyncStatus || null,

    googleLastSyncedAt:
      data.googleLastSyncedAt || null,

    hasPlaintextAdminPassword:
      Object.prototype.hasOwnProperty.call(
        data,
        'adminPassword'
      ),

    hasPasswordHash:
      Boolean(data.passwordHash)
  };
}

async function run() {
  console.log('\n==========================================');
  console.log(' FIRESTORE SECURITY DATA MIGRATION');
  console.log('==========================================');

  console.log(`Firebase Project: ${ PROJECT_ID } `);

  const slugs = [
    'divya-rathod-beauty-salon',
    'sunrise-cafe',
    'thushr'
  ];

  /*
   * Validate that the database is reachable before modifying anything.
   */
  console.log('\nChecking Firestore...');

  for (const slug of slugs) {
    const { data } = await readBusiness(slug);

    console.log(
      `Found ${ slug }: ${ data.name || '(no name)' } `
    );
  }

  /*
   * Backup first.
   */
  console.log('\nCreating Firestore backup...');

  const backupPath =
    await backupBusinesses(slugs);

  console.log(
    `Backup created: ${ backupPath } `
  );

  /*
   * Migrate businesses.
   */
  console.log('\nMigrating Divya...');

  const divya =
    await migrateDivya();

  console.log(divya);

  console.log('\nMigrating Sunrise Cafe...');

  const sunrise =
    await migrateSunrise();

  console.log(sunrise);

  console.log('\nMigrating Thushr...');

  const thushr =
    await migrateThushr();

  console.log(thushr);

  /*
   * Razorpay public configuration.
   */
  console.log('\nUpdating Razorpay public configuration...');

  const razorpay =
    await updateRazorpayPublicConfig();

  console.log(razorpay);

  /*
   * Read back from Firestore.
   */
  console.log('\n==========================================');
  console.log(' FIRESTORE READ-BACK VERIFICATION');
  console.log('==========================================');

  const results = [];

  for (const slug of slugs) {
    const result =
      await verifyBusiness(slug);

    results.push(result);

    console.log(
      JSON.stringify(result, null, 2)
    );
  }

  /*
   * Automated safety assertions.
   */
  console.log('\nRunning safety assertions...');

  const divyaResult = results.find(
    x => x.id === 'divya-rathod-beauty-salon'
  );

  const sunriseResult = results.find(
    x => x.id === 'sunrise-cafe'
  );

  const thushrResult = results.find(
    x => x.id === 'thushr'
  );

  if (
    divyaResult.hasPlaintextAdminPassword
  ) {
    throw new Error(
      'FAIL: Divya still has adminPassword.'
    );
  }

  if (
    sunriseResult.hasPlaintextAdminPassword
  ) {
    throw new Error(
      'FAIL: Sunrise still has adminPassword.'
    );
  }

  if (
    thushrResult.hasPlaintextAdminPassword
  ) {
    throw new Error(
      'FAIL: Thushr still has adminPassword.'
    );
  }

  if (
    !divyaResult.hasPasswordHash
  ) {
    throw new Error(
      'FAIL: Divya has no passwordHash.'
    );
  }

  if (
    !sunriseResult.hasPasswordHash
  ) {
    throw new Error(
      'FAIL: Sunrise has no passwordHash.'
    );
  }

  if (
    !thushrResult.hasPasswordHash
  ) {
    throw new Error(
      'FAIL: Thushr has no passwordHash.'
    );
  }

  if (
    sunriseResult.googlePlaceId
  ) {
    throw new Error(
      'FAIL: Sunrise still has a Google Place ID.'
    );
  }

  if (
    sunriseResult.googleReviewUrl
  ) {
    throw new Error(
      'FAIL: Sunrise still has a Google review URL.'
    );
  }

  if (
    sunriseResult.status !== 'pending_setup'
  ) {
    throw new Error(
      'FAIL: Sunrise is not pending_setup.'
    );
  }

  if (
    sunriseResult.setupStatus !== 'pending'
  ) {
    throw new Error(
      'FAIL: Sunrise setupStatus is not pending.'
    );
  }

  if (
    thushrResult.status !== 'pending_setup'
  ) {
    throw new Error(
      'FAIL: Thushr is not pending_setup.'
    );
  }

  if (
    thushrResult.setupStatus !== 'pending'
  ) {
    throw new Error(
      'FAIL: Thushr setupStatus is not pending.'
    );
  }

  if (
    divyaResult.status !== 'active'
  ) {
    throw new Error(
      'FAIL: Divya is not active.'
    );
  }

  console.log('\n==========================================');
  console.log(' MIGRATION COMPLETED SUCCESSFULLY');
  console.log('==========================================');

  console.log('\nVerified:');
  console.log('✓ Plaintext passwords removed');
  console.log('✓ Password hashes present');
  console.log('✓ Sunrise Divya Place ID removed');
  console.log('✓ Sunrise Google review URL removed');
  console.log('✓ Sunrise moved to pending_setup');
  console.log('✓ Thushr moved to pending_setup');
  console.log('✓ Divya remains active');
  console.log('✓ Firestore read-back passed');

  console.log(
    '\nRazorpay secrets were NOT written to Firestore.'
  );

  console.log(
    'Keep RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET in AWS environment variables.'
  );
}

run().catch(error => {
  console.error('\n==========================================');
  console.error(' MIGRATION FAILED');
  console.error('==========================================');
  console.error(error.message);
  process.exit(1);
});
```
