const twilio = require('twilio');
const db = require('../db');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

/**
 * Send an SMS message via Twilio
 * @param {string} phone - Recipient phone number (E.164 format)
 * @param {string} message - Message content
 * @param {object} options - Additional options (userId, sessionId, messageType)
 * @returns {Promise<object>} Twilio message object
 */
async function sendSMS(phone, message, options = {}) {
    try {
        const twilioMsg = await client.messages.create({
            body: message,
            from: FROM_NUMBER,
            to: phone,
        });

        console.log(`📱 SMS sent to ${phone}: "${message.substring(0, 50)}..."`);

        // Log message to DB if we have user context
        if (options.userId) {
            await db.query(
                `INSERT INTO messages (user_id, session_id, direction, content, message_type, twilio_sid)
         VALUES ($1, $2, 'outgoing', $3, $4, $5)`,
                [
                    options.userId,
                    options.sessionId || null,
                    message,
                    options.messageType || 'general',
                    twilioMsg.sid,
                ]
            );
        }

        return twilioMsg;
    } catch (err) {
        console.error(`❌ Failed to send SMS to ${phone}:`, err.message);
        // Do not throw the error, just return null so onboarding can finish!
        return null;
    }
}

/**
 * Log an incoming message to the DB
 */
async function logIncomingMessage(userId, content, options = {}) {
    try {
        const result = await db.query(
            `INSERT INTO messages (user_id, session_id, direction, content, message_type, twilio_sid)
       VALUES ($1, $2, 'incoming', $3, $4, $5) RETURNING id`,
            [
                userId,
                options.sessionId || null,
                content,
                options.messageType || 'response',
                options.twilioSid || null,
            ]
        );
        return result.rows[0];
    } catch (err) {
        console.error('❌ Failed to log incoming message:', err.message);
    }
}

module.exports = { sendSMS, logIncomingMessage };
