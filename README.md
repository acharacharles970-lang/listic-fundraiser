# Listic Fundraiser – Setup Guide

## Files
- `index.html` → Frontend (place inside a `public/` folder)
- `server.js`  → Node.js backend (M-Pesa STK push)
- `.env.example` → Copy to `.env` and fill in your credentials

## Quick Start

### 1. Install dependencies
```bash
npm init -y
npm install express axios dotenv cors
```

### 2. Set up credentials
```bash
cp .env.example .env
# Edit .env with your Daraja credentials
```

### 3. Place frontend file
```bash
mkdir public
mv index.html public/
```

### 4. Expose callback URL (for testing)
```bash
npx ngrok http 3000
# Copy the HTTPS URL and paste it as CALLBACK_URL in .env
# e.g. https://abc123.ngrok.io/api/mpesa/callback
```

### 5. Run the server
```bash
node server.js
```

Open http://localhost:3000 in your browser.

---

## Getting Daraja Credentials

1. Go to https://developer.safaricom.co.ke and create an account
2. Create a new App → enable **Lipa na M-Pesa Online**
3. Copy your **Consumer Key** and **Consumer Secret** from the Keys tab
4. For the **Shortcode** and **Passkey**:
   - Sandbox: use the test credentials from the Daraja simulator
   - Production: you need a registered Safaricom Paybill or Till number

## Recipient
Donations are sent to **0711 765 392**. This number is hardcoded as the recipient in `server.js`. The contributor enters their own M-Pesa number to receive the STK push prompt and authorize the payment.
