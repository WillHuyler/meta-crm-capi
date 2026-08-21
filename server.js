require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Helper: SHA-256 Hash PII
function hashData(data) {
  if (!data) return null;
  const normalized = data.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// CRM Conversion Event Endpoint
app.post('/webhook/meta-crm-capi', async (req, res) => {
  try {
    const payload = req.body;

    // 1. Extract CRM Details & Identifiers
    const email = payload.email;
    const phone = payload.phone;
    const fbc = payload.fbc; // Facebook Click Cookie
    const fbp = payload.fbp; // Facebook Browser Cookie
    const eventName = payload.event_name || 'Purchase'; // Lead, Purchase, QualifiedLead, etc.
    const eventTime = Math.floor(Date.now() / 1000);
    const eventId = payload.event_id || `crm_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const value = parseFloat(payload.value || 0);
    const currency = payload.currency || 'USD';

    console.log(`📩 CRM Event Received: ${eventName} (Event ID: ${eventId})`);

    // 2. Normalize and SHA-256 Hash User Data
    const hashedEmail = hashData(email);
    const hashedPhone = phone ? hashData(phone.replace(/\D/g, '')) : null;

    const userData = {};
    if (hashedEmail) userData.em = [hashedEmail];
    if (hashedPhone) userData.ph = [hashedPhone];
    if (fbc) userData.fbc = fbc;
    if (fbp) userData.fbp = fbp;

    // 3. Construct Meta CAPI Payload
    const capiPayload = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          event_id: eventId,
          action_source: 'system_generated',
          user_data: userData,
          custom_data: {
            value: value,
            currency: currency,
            crm_stage: payload.crm_stage || 'Closed Won'
          }
        }
      ]
    };

    // 4. Transmit Payload to Meta Graph API
    const datasetId = process.env.META_DATASET_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const url = `https://graph.facebook.com/v19.0/${datasetId}/events?access_token=${accessToken}`;

    const response = await axios.post(url, capiPayload);

    console.log('✅ CRM Event Sent to Meta CAPI:', response.data);
    return res.status(200).json({ status: 'SUCCESS', meta_response: response.data, event_id: eventId });

  } catch (error) {
    const errMessage = error.response ? error.response.data : error.message;
    console.error('❌ Meta CRM CAPI Error:', errMessage);
    return res.status(500).json({ status: 'ERROR', error: errMessage });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Meta CRM CAPI Engine running on http://localhost:${PORT}`);
});