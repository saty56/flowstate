const db = require('../db');
const { sendSMS } = require('./smsService');
const { generateCheckin, rateUserFocus } = require('./aiService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

// Map of active timers: sessionId -> NodeJS.Timeout
const activeCheckinTimers = new Map();
const activeReminderTimers = new Map();

/**
 * Schedule a session and set up the reminder timer
 */
async function scheduleSession(userId, goal, scheduledTime, durationMinutes = 60) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Create the session
        const sessionResult = await client.query(
            `INSERT INTO sessions (user_id, goal, scheduled_time, duration_minutes, status)
       VALUES ($1, $2, $3, $4, 'scheduled') RETURNING *`,
            [userId, goal, scheduledTime, durationMinutes]
        );
        const session = sessionResult.rows[0];

        // Update conversation state
        await client.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'idle', '{}')
       ON CONFLICT (user_id) DO UPDATE SET stage = 'idle', context = '{}', updated_at = NOW()`,
            [userId]
        );

        await client.query('COMMIT');

        // Set up reminder timer (15 minutes before session)
        const userPrefs = await db.query(
            'SELECT * FROM user_preferences WHERE user_id = $1', [userId]
        );
        const leadTime = userPrefs.rows[0]?.reminder_lead_time_minutes ?? 15;
        const reminderTime = dayjs(scheduledTime).subtract(leadTime, 'minute');
        const now = dayjs();

        if (reminderTime.isAfter(now)) {
            const msUntilReminder = reminderTime.diff(now);
            const timer = setTimeout(() => {
                sendPreSessionReminder(session.id);
            }, msUntilReminder);
            activeReminderTimers.set(session.id, timer);
            console.log(`⏰ Reminder set for session ${session.id} in ${Math.round(msUntilReminder / 60000)} min`);
        }

        // Set up session start timer
        const msUntilStart = dayjs(scheduledTime).diff(now);
        if (msUntilStart > 0) {
            setTimeout(() => {
                triggerSessionStart(session.id);
            }, msUntilStart);
            console.log(`🚀 Session start set for ${session.id} in ${Math.round(msUntilStart / 60000)} min`);
        }

        return session;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ scheduleSession error:', err);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Send the pre-session reminder (15min before)
 */
async function sendPreSessionReminder(sessionId) {
    try {
        const { rows } = await db.query(
            `SELECT s.*, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.status = 'scheduled'`,
            [sessionId]
        );
        if (!rows[0]) return;
        const { phone_number, ...rest } = rows[0];

        const message = await generateCheckin({
            user: rest,
            session: rest,
            stage: 'pre_session_reminder',
        });

        await sendSMS(phone_number, message, {
            userId: rest.user_id,
            sessionId,
            messageType: 'reminder',
        });
    } catch (err) {
        console.error('❌ sendPreSessionReminder error:', err.message);
    }
}

/**
 * Trigger session start - send "ready to start?" message
 */
async function triggerSessionStart(sessionId) {
    try {
        const { rows } = await db.query(
            `SELECT s.*, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.status = 'scheduled'`,
            [sessionId]
        );
        if (!rows[0]) return;
        const row = rows[0];

        const message = await generateCheckin({
            user: {
                name: row.name,
                tone_preference: row.tone_preference,
                work_type: row.work_type,
                stuck_points: row.stuck_points,
                checkin_frequency: row.checkin_frequency,
            },
            session: row,
            stage: 'session_start',
        });

        await sendSMS(row.phone_number, message, {
            userId: row.user_id,
            sessionId,
            messageType: 'session_start',
        });

        // Update conversation state to await user response
        await db.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'session_check', $2)
       ON CONFLICT (user_id) DO UPDATE SET stage = 'session_check', context = $2, updated_at = NOW()`,
            [row.user_id, JSON.stringify({ sessionId })]
        );
    } catch (err) {
        console.error('❌ triggerSessionStart error:', err.message);
    }
}

/**
 * Activate a session (user said "Yes")
 */
async function activateSession(sessionId, userId) {
    await db.query(
        `UPDATE sessions SET status = 'active', actual_start_time = NOW() WHERE id = $1`,
        [sessionId]
    );

    const { rows } = await db.query(
        `SELECT s.*, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
     FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = $1`,
        [sessionId]
    );
    const row = rows[0];

    // Schedule periodic check-ins
    scheduleCheckins(sessionId, userId, row.checkin_frequency, {
        name: row.name,
        tone_preference: row.tone_preference,
        work_type: row.work_type,
        stuck_points: row.stuck_points,
        checkin_frequency: row.checkin_frequency,
    }, row);

    // Schedule end-of-session warning (5 min before scheduled end)
    const sessionEnd = dayjs(row.scheduled_time).add(row.duration_minutes, 'minute');
    const warningTime = sessionEnd.subtract(5, 'minute');
    const msUntilWarning = warningTime.diff(dayjs());
    if (msUntilWarning > 0) {
        setTimeout(() => sendSessionWarning(sessionId), msUntilWarning);
    }

    // Schedule session end
    const msUntilEnd = sessionEnd.diff(dayjs());
    if (msUntilEnd > 0) {
        setTimeout(() => endSession(sessionId), msUntilEnd);
    }

    console.log(`✅ Session ${sessionId} activated`);
}

/**
 * Schedule periodic check-ins during a session
 */
function scheduleCheckins(sessionId, userId, frequency, user, session) {
    if (frequency === 'manual') return;

    const intervalMs = parseInt(frequency) * 60 * 1000;
    let count = 0;

    const checkIn = async () => {
        // Check if session is still active
        const { rows } = await db.query('SELECT status FROM sessions WHERE id = $1', [sessionId]);
        if (!rows[0] || rows[0].status !== 'active') {
            clearInterval(timer);
            activeCheckinTimers.delete(sessionId);
            return;
        }

        count++;
        const stage = count === 1 ? 'session_checkin' : (count % 3 === 0 ? 'session_quiet' : 'session_checkin');

        const { rows: userRows } = await db.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
        if (!userRows[0]) return;

        const message = await generateCheckin({ user, session, stage });
        await sendSMS(userRows[0].phone_number, message, {
            userId,
            sessionId,
            messageType: 'checkin',
        });
    };

    const timer = setInterval(checkIn, intervalMs);
    activeCheckinTimers.set(sessionId, timer);
}

/**
 * Send session warning (5 min left)
 */
async function sendSessionWarning(sessionId) {
    try {
        const { rows } = await db.query(
            `SELECT s.*, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.status = 'active'`,
            [sessionId]
        );
        if (!rows[0]) return;
        const row = rows[0];

        const message = await generateCheckin({
            user: row,
            session: row,
            stage: 'session_warning',
        });
        await sendSMS(row.phone_number, message, {
            userId: row.user_id,
            sessionId,
            messageType: 'checkin',
        });
    } catch (err) {
        console.error('❌ sendSessionWarning error:', err.message);
    }
}

/**
 * End a session - ask for accomplishments
 */
async function endSession(sessionId) {
    try {
        // Clear any check-in timers
        if (activeCheckinTimers.has(sessionId)) {
            clearInterval(activeCheckinTimers.get(sessionId));
            activeCheckinTimers.delete(sessionId);
        }

        const { rows } = await db.query(
            `SELECT s.*, u.id as uid, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.status IN ('active', 'scheduled')`,
            [sessionId]
        );
        if (!rows[0]) return;
        const row = rows[0];

        // Update session status
        await db.query(
            'UPDATE sessions SET status = $1, actual_end_time = NOW() WHERE id = $2',
            ['completed', sessionId]
        );

        const message = await generateCheckin({
            user: row,
            session: row,
            stage: 'session_end',
        });
        await sendSMS(row.phone_number, message, {
            userId: row.uid,
            sessionId,
            messageType: 'celebration',
        });

        // Update conversation state to await accomplishments
        await db.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'awaiting_accomplishments', $2)
       ON CONFLICT (user_id) DO UPDATE SET stage = 'awaiting_accomplishments', context = $2, updated_at = NOW()`,
            [row.uid, JSON.stringify({ sessionId })]
        );
    } catch (err) {
        console.error('❌ endSession error:', err.message);
    }
}

/**
 * Handle session accomplishments, send celebration, offer to schedule next
 */
async function handleAccomplishments(userId, sessionId, accomplishments) {
    const { rows } = await db.query(
        `SELECT s.*, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
     FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = $1`,
        [sessionId]
    );
    if (!rows[0]) return;
    const row = rows[0];

    // Get AI Focus Rating
    const focus_rating = await rateUserFocus(accomplishments, row.goal);

    // Calculate momentum score
    // Logic: rating * 10 
    // Bonus for consistency (optional)
    const momentum_score = focus_rating * 10;

    await db.query(
        'UPDATE sessions SET accomplishments = $1, focus_rating = $2, momentum_score = $3 WHERE id = $4',
        [accomplishments, focus_rating, momentum_score, sessionId]
    );

    row.accomplishments = accomplishments;

    const celebrationMsg = await generateCheckin({
        user: row,
        session: row,
        stage: 'celebration',
    });

    await sendSMS(row.phone_number, celebrationMsg, {
        userId,
        sessionId,
        messageType: 'celebration',
    });

    // Reset conversation state to idle
    await db.query(
        `UPDATE conversation_state SET stage = 'idle', context = '{}', updated_at = NOW() WHERE user_id = $1`,
        [userId]
    );
}

/**
 * Mark a session as missed and reach out
 */
async function markSessionMissed(sessionId) {
    try {
        const { rows } = await db.query(
            `SELECT s.*, u.id as uid, u.name, u.phone_number, u.tone_preference, u.work_type, u.stuck_points, u.checkin_frequency
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.status = 'scheduled'`,
            [sessionId]
        );
        if (!rows[0]) return;
        const row = rows[0];

        await db.query('UPDATE sessions SET status = $1 WHERE id = $2', ['missed', sessionId]);

        const message = await generateCheckin({
            user: row,
            session: row,
            stage: 'missed_session',
        });
        await sendSMS(row.phone_number, message, {
            userId: row.uid,
            sessionId,
            messageType: 'missed',
        });

        await db.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'idle', '{}')
       ON CONFLICT (user_id) DO UPDATE SET stage = 'idle', context = '{}', updated_at = NOW()`,
            [row.uid]
        );
    } catch (err) {
        console.error('❌ markSessionMissed error:', err.message);
    }
}

/**
 * Restore active session timers on server restart
 */
async function restoreActiveTimers() {
    try {
        const now = new Date();
        const { rows } = await db.query(
            `SELECT s.id, s.scheduled_time, s.duration_minutes, s.status, s.user_id
       FROM sessions s
       WHERE s.status IN ('scheduled', 'active') 
       AND s.scheduled_time > NOW() - INTERVAL '120 minutes'`,
            []
        );

        for (const session of rows) {
            const scheduledTime = dayjs(session.scheduled_time);
            const msUntilStart = scheduledTime.diff(dayjs());

            if (session.status === 'scheduled') {
                if (msUntilStart > 0) {
                    setTimeout(() => triggerSessionStart(session.id), msUntilStart);
                    // Also set reminder
                    const leadTime = 15;
                    const reminderMs = scheduledTime.subtract(leadTime, 'minute').diff(dayjs());
                    if (reminderMs > 0) {
                        setTimeout(() => sendPreSessionReminder(session.id), reminderMs);
                    }
                } else {
                    // Overdue scheduled session - mark as missed
                    await markSessionMissed(session.id);
                }
            } else if (session.status === 'active') {
                // Recover active session - just schedule end
                const endTime = scheduledTime.add(session.duration_minutes, 'minute');
                const msUntilEnd = endTime.diff(dayjs());
                if (msUntilEnd > 0) {
                    setTimeout(() => endSession(session.id), msUntilEnd);
                } else {
                    await endSession(session.id);
                }
            }
        }

        console.log(`🔄 Restored ${rows.length} session timers`);
    } catch (err) {
        console.error('❌ restoreActiveTimers error:', err.message);
    }
}

module.exports = {
    scheduleSession,
    triggerSessionStart,
    activateSession,
    endSession,
    handleAccomplishments,
    markSessionMissed,
    restoreActiveTimers,
    sendPreSessionReminder,
};
