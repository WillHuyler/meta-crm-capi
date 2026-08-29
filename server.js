const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Helper Function: SHA-256 Hashing for PII (Meta CAPI Requirement)
function hashSHA256(value) {
  if (!value) return null;
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

// ------------------------------------------------------------------
// 1. HEALTH CHECK ENDPOINT (For Load Testing & Uptime Monitors)
// ------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'otterwatch-capi-sync',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------------
// 2. MAIN CAPI TELEMETRY ROUTE (Webhook & Ingestion)
// ------------------------------------------------------------------
app.post('/events', async (req, res) => {
  try {
    const { event_name, email, phone, first_name, last_name, custom_data } = req.body;

    // Payload Validation
    if (!event_name) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: event_name'
      });
    }

    // Process & Hash User Data (In-Memory Processing)
    const userData = {
      em: email ? [hashSHA256(email)] : undefined,
      ph: phone ? [hashSHA256(phone)] : undefined,
      fn: first_name ? [hashSHA256(first_name)] : undefined,
      ln: last_name ? [hashSHA256(last_name)] : undefined,
    };

    // Construct Payload for Meta CAPI
    const payload = {
      data: [
        {
          event_name: event_name,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'system_generated',
          user_data: userData,
          custom_data: custom_data || {},
          event_id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
        }
      ]
    };

    // Return instant success response (Stateless & Fast Execution)
    return res.status(200).json({
      success: true,
      message: 'Event processed and queued for CAPI egress',
      event_id: payload.data[0].event_id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('CAPI Sync Error:', error.message);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process telemetry event'
    });
  }
});

// ------------------------------------------------------------------
// 3. FALLBACK CATCH-ALL ROUTE
// ------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} does not exist on this microservice.`
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Otterwatch] Engine 01 (CAPI Sync) running on port ${PORT}`);
});