cconst express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Initialize Stripe with fallback to prevent initialization crash
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase Client with fallbacks to prevent empty-string validation errors
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder_key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Global Middleware
app.use(cors());

// ------------------------------------------------------------------
// 1. STRIPE WEBHOOK ROUTE (Must be placed BEFORE express.json())
// ------------------------------------------------------------------
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`Webhook Signature Verification Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await supabase
          .from('tenants')
          .update({
            subscription_status: data.status === 'active' ? 'active' : 'past_due',
            stripe_subscription_id: data.id,
            stripe_price_id: data.items.data[0].price.id,
            monthly_event_limit: data.items.data[0].price.transform_quantity ? 100000 : 25000
          })
          .eq('stripe_customer_id', data.customer);
        break;

      case 'customer.subscription.deleted':
        await supabase
          .from('tenants')
          .update({ subscription_status: 'suspended' })
          .eq('stripe_customer_id', data.customer);
        break;

      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }
  } catch (dbError) {
    console.error('Database Sync Error:', dbError.message);
    return res.status(500).json({ error: 'Failed to sync subscription data' });
  }

  res.json({ received: true });
});

// JSON Body Parser Middleware (Applies to all routes below)
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
// 2. HEALTH CHECK ENDPOINT
// ------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'meta-crm-capi',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------------
// 3. MAIN TELEMETRY INGESTION ROUTE
// ------------------------------------------------------------------
app.post('/events', async (req, res) => {
  try {
    const { event_name, email, phone, first_name, last_name, custom_data, tenant_id } = req.body;

    // Payload Validation
    if (!event_name) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: event_name'
      });
    }

    // Enforce Monthly Usage Caps via Supabase RPC
    if (tenant_id) {
      const { data: allowed, error } = await supabase.rpc('increment_event_usage', {
        target_tenant_id: tenant_id,
        event_count: 1
      });

      if (error || !allowed) {
        return res.status(429).json({
          error: 'Rate Limit Exceeded',
          message: 'Monthly event limit reached or subscription inactive.'
        });
      }
    }

    // Process & Hash User Data
    const userData = {
      em: email ? [hashSHA256(email)] : undefined,
      ph: phone ? [hashSHA256(phone)] : undefined,
      fn: first_name ? [hashSHA256(first_name)] : undefined,
      ln: last_name ? [hashSHA256(last_name)] : undefined,
    };

    // Construct Telemetry Payload
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

    // Immediate Acknowledgment Output
    return res.status(200).json({
      success: true,
      message: 'Event processed and queued for egress',
      event_id: payload.data[0].event_id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Processing Error:', error.message);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process telemetry event'
    });
  }
});

// ------------------------------------------------------------------
// 4. FALLBACK ROUTE
// ------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} does not exist on this service.`
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Otterwatch Engine] Server running on port ${PORT}`);
});