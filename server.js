/**
 * Listic Fundraiser – M-Pesa STK Push Backend
 * ============================================
 * Node.js + Express server that:
 *  1. Obtains a Daraja OAuth token
 *  2. Initiates an STK Push (Lipa na M-Pesa Online / CustomerBuyGoodsOnline)
 *  3. Receives the Safaricom callback and stores the result
 *  4. Exposes a status endpoint so the frontend can poll
 *
 * SETUP
 * -----
 *  npm install express axios dotenv cors
 *  node server.js
 *
 * ENVIRONMENT VARIABLES  (.env file)
 * -----------------------------------
 *  CONSUMER_KEY=<from Daraja portal>
 *  CONSUMER_SECRET=<from Daraja portal>
 *  SHORTCODE=<your Paybill or Till number>
 *  PASSKEY=<Lipa na M-Pesa passkey from Daraja>
 *  CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
 *  PORT=3000
 *
 * NOTE: The recipient number 0711765392 is hardcoded as the destination
 * (PhoneNumber / PartyB). In a Till-based flow the SHORTCODE IS the
 * destination; in a Paybill flow set TransactionType to
 * "CustomerPayBillOnline" and set PartyB to your paybill shortcode.
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Serve the static frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store for payment statuses ────────────────────────────
// In production replace with a real database (PostgreSQL, MongoDB, etc.)
const paymentStore = {};   // { [CheckoutRequestID]: { status, message } }

// ── Daraja credentials from .env ─────────────────────────────────────
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,      // Your Paybill or Till number
  PASSKEY,        // Lipa na M-Pesa passkey
  CALLBACK_URL    // Must be a public HTTPS URL reachable by Safaricom
} = process.env;

const DARAJA_BASE = 'https://api.safaricom.co.ke';   // Production
// const DARAJA_BASE = 'https://sandbox.safaricom.co.ke'; // Sandbox

// ── RECIPIENT (hardcoded) ─────────────────────────────────────────────
const RECIPIENT_PHONE = '254711765392';  // 0711765392

// ── Helper: get OAuth token ────────────────────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return data.access_token;
}

// ── Helper: build timestamp & password ────────────────────────────────
function getTimestampAndPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
  return { timestamp, password };
}

// ── POST /api/stk-push ─────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, amount, description } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ errorMessage: 'phone and amount are required' });
  }

  try {
    const token                = await getAccessToken();
    const { timestamp, password } = getTimestampAndPassword();

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerBuyGoodsOnline',  // Use for Till numbers
      // TransactionType: 'CustomerPayBillOnline',  // Use for Paybill numbers
      Amount:            Math.ceil(amount),
      PartyA:            phone,              // Contributor's number (payer)
      PartyB:            SHORTCODE,          // Your Till / Paybill number
      PhoneNumber:       phone,              // Number to receive STK prompt
      CallBackURL:       CALLBACK_URL,
      AccountReference:  'DominicOyagi',
      TransactionDesc:   description || 'Dominic Oyagi – Mathare Hospital Fund'
    };

    const { data } = await axios.post(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Initialise status as pending
    if (data.CheckoutRequestID) {
      paymentStore[data.CheckoutRequestID] = { status: 'pending' };
    }

    return res.json(data);  // Forward Daraja response to frontend
  } catch (err) {
    console.error('STK push error:', err?.response?.data || err.message);
    return res.status(500).json({
      errorMessage: err?.response?.data?.errorMessage || 'STK push failed. Please try again.'
    });
  }
});

// ── POST /api/mpesa/callback ────────────────────────────────────────────
// Safaricom will POST the transaction result to this URL
app.post('/api/mpesa/callback', (req, res) => {
  const body = req.body?.Body?.stkCallback;

  if (!body) {
    console.warn('Unexpected callback payload:', JSON.stringify(req.body));
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;
  console.log(`Callback received – CheckoutID: ${CheckoutRequestID}, ResultCode: ${ResultCode}`);

  if (ResultCode === 0) {
    // Payment successful
    const meta = {};
    CallbackMetadata?.Item?.forEach(item => { meta[item.Name] = item.Value; });
    paymentStore[CheckoutRequestID] = {
      status:  'success',
      amount:  meta.Amount,
      receipt: meta.MpesaReceiptNumber,
      phone:   meta.PhoneNumber,
      date:    meta.TransactionDate
    };
    console.log('✅ Payment confirmed:', meta);
  } else {
    // Payment failed or cancelled
    paymentStore[CheckoutRequestID] = {
      status:  ResultCode === 1032 ? 'cancelled' : 'failed',
      message: ResultDesc
    };
    console.log(`❌ Payment ${ResultCode === 1032 ? 'cancelled' : 'failed'}: ${ResultDesc}`);
  }

  // Always respond 200 to Safaricom
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ── GET /api/stk-status?checkoutId=xxx ─────────────────────────────────
// Frontend polls this to know if payment completed
app.get('/api/stk-status', (req, res) => {
  const { checkoutId } = req.query;
  if (!checkoutId) return res.status(400).json({ error: 'checkoutId required' });

  const record = paymentStore[checkoutId] || { status: 'pending' };
  return res.json(record);
});

// ── Fallback: serve index.html for all other routes ────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Listic Fundraiser server running on http://localhost:${PORT}`);
  console.log(`📞 Recipient number: ${RECIPIENT_PHONE}`);
  console.log(`📋 Callback URL: ${CALLBACK_URL}\n`);
});
