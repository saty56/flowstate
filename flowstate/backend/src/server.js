require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { restoreActiveTimers } = require('./services/sessionService');
const { initCronJobs } = require('./services/cronService');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5500',
    credentials: true,
}));

// Raw body for Twilio signature validation
app.use('/api/sms', express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────
app.use('/api/onboard', require('./routes/onboard'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/users', require('./routes/users'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/auth', require('./routes/auth'));

// ──────────────────────────────────────────────
// Error handling
// ──────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`\n🚀 FlowState API running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5500'}\n`);

    // Initialize cron jobs
    initCronJobs();

    // Restore any active session timers from DB (handles server restarts)
    try {
        await restoreActiveTimers();
    } catch (err) {
        console.warn('⚠️ Could not restore timers (DB may not be connected):', err.message);
    }
});

module.exports = app;
