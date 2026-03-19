const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { processIncomingMessage } = require('../services/messageService');

/**
 * POST /api/sms/incoming
 * Twilio webhook for incoming SMS messages
 */
router.post('/incoming', async (req, res) => {
    // Validate Twilio signature in production
    if (process.env.NODE_ENV === 'production') {
        const twilioSignature = req.headers['x-twilio-signature'];
        const url = `${process.env.BASE_URL}/api/sms/incoming`;
        const isValid = twilio.validateRequest(
            process.env.TWILIO_AUTH_TOKEN,
            twilioSignature,
            url,
            req.body
        );
        if (!isValid) {
            console.warn('⚠️ Invalid Twilio signature - rejecting request');
            return res.status(403).send('Forbidden');
        }
    }

    const { From: phone, Body: text, MessageSid: twilioSid } = req.body;

    if (!phone || !text) {
        return res.status(400).send('Missing required fields');
    }

    // Respond immediately to Twilio (within 15s) - process async
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

    // Process the message asynchronously
    setImmediate(() => {
        processIncomingMessage(phone, text.trim(), twilioSid).catch(err => {
            console.error('❌ Async message processing error:', err.message);
        });
    });
});

/**
 * POST /api/sms/status
 * Twilio status callback for message delivery tracking
 */
router.post('/status', (req, res) => {
    const { MessageSid, MessageStatus, To } = req.body;
    console.log(`📱 SMS Status: ${MessageSid} → ${MessageStatus} → ${To}`);
    res.status(200).send('OK');
});

module.exports = router;
