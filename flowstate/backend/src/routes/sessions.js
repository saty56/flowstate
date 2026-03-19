const express = require('express');
const router = express.Router();
const db = require('../db');
const { scheduleSession } = require('../services/sessionService');

/**
 * GET /api/sessions?userId=xxx
 * Get sessions for a user
 */
router.get('/', async (req, res) => {
    try {
        const { userId, status, limit = 20 } = req.query;
        if (!userId) return res.status(400).json({ error: 'userId is required' });

        let q = `SELECT * FROM sessions WHERE user_id = $1`;
        const values = [userId];

        if (status) {
            q += ` AND status = $2`;
            values.push(status);
        }
        q += ` ORDER BY scheduled_time DESC LIMIT $${values.length + 1}`;
        values.push(parseInt(limit));

        const { rows } = await db.query(q, values);
        res.json({ sessions: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/sessions
 * Manually create and schedule a session
 */
router.post('/', async (req, res) => {
    try {
        const { userId, goal, scheduledTime, durationMinutes = 60 } = req.body;

        if (!userId || !goal || !scheduledTime) {
            return res.status(400).json({ error: 'userId, goal, and scheduledTime are required' });
        }

        const session = await scheduleSession(userId, goal, new Date(scheduledTime), durationMinutes);
        res.status(201).json({ success: true, session });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PATCH /api/sessions/:id
 * Update a session (e.g., rating, cancellation)
 */
router.patch('/:id', async (req, res) => {
    try {
        const { status, user_rating, accomplishments } = req.body;
        const sessionId = req.params.id;

        const updates = [];
        const values = [];
        let idx = 1;

        if (status) { updates.push(`status = $${idx++}`); values.push(status); }
        if (user_rating) { updates.push(`user_rating = $${idx++}`); values.push(user_rating); }
        if (accomplishments) { updates.push(`accomplishments = $${idx++}`); values.push(accomplishments); }

        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

        values.push(sessionId);
        const { rows } = await db.query(
            `UPDATE sessions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values
        );

        if (!rows[0]) return res.status(404).json({ error: 'Session not found' });
        res.json({ session: rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/sessions/:id/messages
 * Get all messages for a session
 */
router.get('/:id/messages', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC`,
            [req.params.id]
        );
        res.json({ messages: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
