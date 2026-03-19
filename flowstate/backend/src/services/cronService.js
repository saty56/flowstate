const cron = require('node-cron');
const db = require('../db');
const { sendSMS } = require('./smsService');
const { generateCheckin, generateWeeklyRecap } = require('./aiService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Initialize all cron jobs
 */
function initCronJobs() {
    // Morning check-in: every minute, check if any user needs their 9am message
    cron.schedule('* * * * *', async () => {
        await sendMorningCheckins();
    });

    // Weekly recap: every Sunday at 8pm UTC (adjust offsets for timezones in the function)
    cron.schedule('0 20 * * 0', async () => {
        await sendWeeklyRecaps();
    });

    // Miss detection: every 5 minutes, check for sessions that started but user never replied
    cron.schedule('*/5 * * * *', async () => {
        await detectMissedSessions();
    });

    console.log('⏰ Cron jobs initialized');
}

/**
 * Send morning check-ins to users whose 9am just arrived
 */
async function sendMorningCheckins() {
    try {
        const { rows: users } = await db.query(`
      SELECT u.*, up.morning_checkin_time
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      WHERE u.active = true AND u.onboarded = true
    `);

        const now = dayjs().utc();

        for (const user of users) {
            const userNow = now.tz(user.timezone);
            const checkinTime = user.morning_checkin_time || '09:00:00';
            const [h, m] = checkinTime.split(':').map(Number);

            // Check if current minute matches 9am in user's timezone
            if (userNow.hour() === h && userNow.minute() === m) {
                // Check if we already sent a morning check-in today
                const today = userNow.startOf('day').toDate();
                const { rows: existing } = await db.query(
                    `SELECT id FROM messages
           WHERE user_id = $1 AND message_type = 'morning_checkin'
           AND created_at >= $2 LIMIT 1`,
                    [user.id, today]
                );

                if (existing.length === 0) {
                    await sendMorningCheckin(user);
                }
            }
        }
    } catch (err) {
        console.error('❌ sendMorningCheckins cron error:', err.message);
    }
}

/**
 * Send the morning check-in to a specific user
 */
async function sendMorningCheckin(user) {
    try {
        const message = await generateCheckin({
            user,
            session: null,
            stage: 'morning_checkin',
        });

        await sendSMS(user.phone_number, message, {
            userId: user.id,
            messageType: 'morning_checkin',
        });

        // Set conversation state to awaiting goal
        await db.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'awaiting_goal', '{}')
       ON CONFLICT (user_id) DO UPDATE SET stage = 'awaiting_goal', context = '{}', updated_at = NOW()`,
            [user.id]
        );

        console.log(`🌅 Morning check-in sent to ${user.name}`);
    } catch (err) {
        console.error(`❌ Morning check-in failed for ${user.name}:`, err.message);
    }
}

/**
 * Detect sessions that were scheduled but user never responded
 */
async function detectMissedSessions() {
    try {
        const cutoff = dayjs().subtract(30, 'minute').toDate();
        const { rows } = await db.query(
            `SELECT id FROM sessions
       WHERE status = 'scheduled' AND scheduled_time < $1`,
            [cutoff]
        );

        for (const session of rows) {
            const { markSessionMissed } = require('./sessionService');
            await markSessionMissed(session.id);
        }

        if (rows.length > 0) {
            console.log(`⚠️ Marked ${rows.length} sessions as missed`);
        }
    } catch (err) {
        console.error('❌ detectMissedSessions cron error:', err.message);
    }
}

/**
 * Send weekly recaps every Sunday
 */
async function sendWeeklyRecaps() {
    try {
        const { rows: users } = await db.query(
            `SELECT u.*, up.weekly_recap_enabled
       FROM users u
       LEFT JOIN user_preferences up ON u.id = up.user_id
       WHERE u.active = true AND u.onboarded = true`
        );

        for (const user of users) {
            if (user.weekly_recap_enabled === false) continue;

            try {
                const stats = await getUserWeeklyStats(user.id);
                const message = await generateWeeklyRecap(user, stats);

                await sendSMS(user.phone_number, message, {
                    userId: user.id,
                    messageType: 'weekly_recap',
                });

                console.log(`📊 Weekly recap sent to ${user.name}`);
            } catch (err) {
                console.error(`❌ Weekly recap failed for ${user.name}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ sendWeeklyRecaps error:', err.message);
    }
}

/**
 * Compute weekly session stats for a user
 */
async function getUserWeeklyStats(userId) {
    const thisWeekStart = dayjs().startOf('week').toDate();
    const lastWeekStart = dayjs().subtract(1, 'week').startOf('week').toDate();
    const lastWeekEnd = dayjs().startOf('week').toDate();

    const { rows: thisWeek } = await db.query(
        `SELECT COUNT(*) as count FROM sessions
     WHERE user_id = $1 AND status = 'completed' AND created_at >= $2`,
        [userId, thisWeekStart]
    );

    const { rows: lastWeek } = await db.query(
        `SELECT COUNT(*) as count FROM sessions
     WHERE user_id = $1 AND status = 'completed' AND created_at >= $2 AND created_at < $3`,
        [userId, lastWeekStart, lastWeekEnd]
    );

    const { rows: goalTypes } = await db.query(
        `SELECT goal FROM sessions
     WHERE user_id = $1 AND status = 'completed' AND created_at >= $2
     LIMIT 10`,
        [userId, thisWeekStart]
    );

    return {
        sessionsThisWeek: parseInt(thisWeek[0]?.count || 0),
        sessionsLastWeek: parseInt(lastWeek[0]?.count || 0),
        bestStreak: calculateStreak(userId),
        topGoalArea: goalTypes[0]?.goal?.substring(0, 50) || 'various projects',
    };
}

async function calculateStreak(userId) {
    // Simple streak: consecutive days with completed sessions
    const { rows } = await db.query(
        `SELECT DISTINCT DATE(actual_end_time AT TIME ZONE 'UTC') as day
     FROM sessions
     WHERE user_id = $1 AND status = 'completed'
     ORDER BY day DESC LIMIT 30`,
        [userId]
    );

    let streak = 0;
    let checkDate = dayjs().startOf('day');

    for (const row of rows) {
        const sessionDay = dayjs(row.day);
        if (sessionDay.isSame(checkDate, 'day') || sessionDay.isSame(checkDate.subtract(1, 'day'), 'day')) {
            streak++;
            checkDate = sessionDay;
        } else {
            break;
        }
    }
    return streak;
}

module.exports = { initCronJobs, sendMorningCheckin, getUserWeeklyStats };
