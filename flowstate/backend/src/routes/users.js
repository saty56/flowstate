const express = require('express');
const router = express.Router();
const db = require('../db');
const { google, oauth2Client } = require('../utils/googleAuth');
const integrationService = require('../services/integrationService');

/**
 * GET /api/users/:id
 * Get user profile + stats
 */
router.get('/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT u.*, up.morning_checkin_time, up.weekly_recap_enabled
       FROM users u
       LEFT JOIN user_preferences up ON u.id = up.user_id
       WHERE u.id = $1`,
            [req.params.id]
        );

        if (!rows[0]) return res.status(404).json({ error: 'User not found' });

        // Remove sensitive fields
        const { password_hash, ...user } = rows[0];
        user.has_google = !!user.google_id;
        user.has_todoist = false;
        res.json({ user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/users/:id/stats
 * Get user's session statistics for dashboard
 */
router.get('/:id/stats', async (req, res) => {
    try {
        const userId = req.params.id;

        const [sessionsResult, weeklyResult, streakResult, recentResult, momentumResult] = await Promise.all([
            // Total sessions
            db.query(
                'SELECT COUNT(*) as total FROM sessions WHERE user_id = $1 AND status = $2',
                [userId, 'completed']
            ),
            // This week vs last week
            db.query(
                `SELECT
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW())) as this_week,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW() - INTERVAL '1 week')
                           AND created_at < date_trunc('week', NOW())) as last_week
         FROM sessions WHERE user_id = $1 AND status = 'completed'`,
                [userId]
            ),
            // Focus streak (days with at least one completed session)
            db.query(
                `SELECT EXTRACT(DAY FROM (NOW() - MIN(actual_end_time))) as streak_days
         FROM sessions
         WHERE user_id = $1 AND status = 'completed'
         AND actual_end_time >= NOW() - INTERVAL '30 days'`,
                [userId]
            ),
            // Recent 5 sessions
            db.query(
                `SELECT id, goal, status, scheduled_time, actual_start_time, actual_end_time, accomplishments, momentum_score
         FROM sessions WHERE user_id = $1
         ORDER BY scheduled_time DESC LIMIT 5`,
                [userId]
            ),
            // Momentum scores for the last 7 days
            db.query(
                `SELECT date_trunc('day', created_at) as day, ROUND(AVG(momentum_score)) as avg_momentum
                 FROM sessions 
                 WHERE user_id = $1 AND status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
                 GROUP BY 1 ORDER BY 1 ASC`,
                [userId]
            ),
        ]);

        res.json({
            totalSessions: parseInt(sessionsResult.rows[0]?.total || 0),
            thisWeek: parseInt(weeklyResult.rows[0]?.this_week || 0),
            lastWeek: parseInt(weeklyResult.rows[0]?.last_week || 0),
            recentSessions: recentResult.rows,
            momentumTrend: momentumResult.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PATCH /api/users/:id
 * Update user preferences
 */
router.patch('/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        const {
            tone_preference,
            checkin_frequency,
            phone_number,
            morning_checkin_time,
            quiet_hours_start,
            quiet_hours_end,
            weekly_recap_enabled,
        } = req.body;

        if (tone_preference || checkin_frequency || phone_number) {
            const updates = [];
            const values = [];
            let idx = 1;

            if (tone_preference) { updates.push(`tone_preference = $${idx++}`); values.push(tone_preference); }
            if (checkin_frequency) { updates.push(`checkin_frequency = $${idx++}`); values.push(checkin_frequency); }
            if (phone_number) { updates.push(`phone_number = $${idx++}`); values.push(phone_number); }
            values.push(userId);

            await db.query(
                `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
                values
            );
        }

        if (morning_checkin_time !== undefined || quiet_hours_start !== undefined ||
            quiet_hours_end !== undefined || weekly_recap_enabled !== undefined) {
            const updates = [];
            const values = [];
            let idx = 1;

            if (morning_checkin_time !== undefined) { updates.push(`morning_checkin_time = $${idx++}`); values.push(morning_checkin_time); }
            if (quiet_hours_start !== undefined) { updates.push(`quiet_hours_start = $${idx++}`); values.push(quiet_hours_start); }
            if (quiet_hours_end !== undefined) { updates.push(`quiet_hours_end = $${idx++}`); values.push(quiet_hours_end); }
            if (weekly_recap_enabled !== undefined) { updates.push(`weekly_recap_enabled = $${idx++}`); values.push(weekly_recap_enabled); }
            values.push(userId);

            await db.query(
                `INSERT INTO user_preferences (user_id, ${updates.map(u => u.split(' = ')[0]).join(', ')})
         VALUES ($${idx}, ${Array.from({ length: updates.length }, (_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}, updated_at = NOW()`,
                [...values.slice(0, -1), userId]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/users/:id/integrations/todoist
 * Connect Todoist account via API token
 */
router.post('/:id/integrations/todoist', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        // Update user's todoist token
        await db.query(
            'UPDATE users SET todoist_token = $1 WHERE id = $2',
            [token, req.params.id]
        );

        res.json({ success: true, message: 'Todoist connected' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});



/**
 * GET /api/users/:id/integrations/google/auth-url
 * Get OAuth2 URL for Google Calendar
 */
router.get('/:id/integrations/google/auth-url', (req, res) => {
    const isConfigured = !process.env.GOOGLE_CLIENT_ID.includes('your-google-client-id');
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar.readonly'],
        state: req.params.id,
        prompt: 'consent'
    });
    res.json({ url, configured: isConfigured });
});

/**
 * GET /api/users/:id/integrations/todoist/tasks
 * Fetch open tasks from Todoist
 */
router.get('/:id/integrations/todoist/tasks', async (req, res) => {
    try {
        const tasks = await integrationService.getUserTodoistTasks(req.params.id);
        res.json({ tasks });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

module.exports = router;
