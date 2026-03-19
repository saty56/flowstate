const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { sendSMS } = require('../services/smsService');
const { scheduleSession } = require('../services/sessionService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * POST /api/onboard
 * Create a new user account
 */
router.post('/', [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone_number').trim().notEmpty().withMessage('Phone number is required'),
    body('timezone').trim().notEmpty().withMessage('Timezone is required'),
    body('work_type').trim().notEmpty().withMessage('Work type is required'),
    body('tone_preference').isIn(['cheerleader', 'coach', 'gentle']).withMessage('Invalid tone preference'),
    body('checkin_frequency').isIn(['5', '15', '30', 'manual']).withMessage('Invalid check-in frequency'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
        userId,
        name,
        phone_number,
        timezone: tz,
        work_type,
        stuck_points = [],
        checkin_frequency,
        tone_preference,
        morning_checkin_time = '09:00',
    } = req.body;

    if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    // Store the exact phone number as entered by the user
    const normalizedPhone = phone_number.trim();

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Check for existing user with same phone
        const existing = await client.query(
            'SELECT id FROM users WHERE phone_number = $1 AND id != $2',
            [normalizedPhone, userId]
        );
        if (existing.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                error: 'A user with this phone number already exists.',
                userId: existing.rows[0].id,
            });
        }

        // Update user
        const userResult = await client.query(
            `UPDATE users 
             SET name = COALESCE($1, name), 
                 phone_number = $2, 
                 timezone = $3, 
                 work_type = $4, 
                 stuck_points = $5, 
                 checkin_frequency = $6, 
                 tone_preference = $7, 
                 onboarded = true
             WHERE id = $8 RETURNING *`,
            [name, normalizedPhone, tz, work_type, stuck_points, checkin_frequency, tone_preference, userId]
        );
        const user = userResult.rows[0];

        if (!user) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Update user preferences
        await client.query(
            `UPDATE user_preferences SET morning_checkin_time = $1 WHERE user_id = $2`,
            [morning_checkin_time, userId]
        );

        await client.query('COMMIT');

        // Send welcome SMS
        const welcomeMessages = {
            cheerleader: `🎉 Welcome to FlowState, ${name}! I'm SO excited to be your ADHD accountability partner! Your morning check-ins start tomorrow at ${morning_checkin_time}. You've GOT this! 💪`,
            coach: `Welcome to FlowState, ${name}. I'm your accountability partner. Starting tomorrow at ${morning_checkin_time}, I'll check in with your daily priority. Let's build some momentum.`,
            gentle: `Hi ${name}, welcome to FlowState! 💙 I'm here to gently support your focus journey. I'll reach out tomorrow at ${morning_checkin_time} to check in. No pressure, just steady support.`,
        };

        await sendSMS(normalizedPhone, welcomeMessages[tone_preference] || welcomeMessages.coach, {
            userId: user.id,
            messageType: 'onboarding',
        });

        res.status(201).json({
            success: true,
            message: 'User created successfully. Welcome SMS sent!',
            userId: user.id,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Onboarding error:', err.message);

        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Phone number already registered.' });
        }
        res.status(500).json({ success: false, error: 'Failed to create account. Please try again.' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/onboard/timezones
 * Return common timezone list
 */
router.get('/timezones', (req, res) => {
    const timezones = [
        { value: 'America/New_York', label: 'Eastern Time (ET)' },
        { value: 'America/Chicago', label: 'Central Time (CT)' },
        { value: 'America/Denver', label: 'Mountain Time (MT)' },
        { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
        { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
        { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
        { value: 'Europe/London', label: 'London (GMT/BST)' },
        { value: 'Europe/Paris', label: 'Central European Time (CET)' },
        { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
        { value: 'Asia/Dubai', label: 'Dubai (GST)' },
        { value: 'Asia/Kolkata', label: 'India (IST)' },
        { value: 'Asia/Singapore', label: 'Singapore (SST)' },
        { value: 'Asia/Tokyo', label: 'Japan (JST)' },
        { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
        { value: 'America/Sao_Paulo', label: 'São Paulo (BRT)' },
        { value: 'America/Toronto', label: 'Toronto (ET)' },
        { value: 'America/Vancouver', label: 'Vancouver (PT)' },
    ];
    res.json({ timezones });
});

module.exports = router;
