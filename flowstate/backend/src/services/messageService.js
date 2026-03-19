const db = require('../db');
const { sendSMS } = require('./smsService');
const { generateCheckin, parseUserIntent } = require('./aiService');
const { scheduleSession, activateSession, handleAccomplishments } = require('./sessionService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/**
 * Main entry point for ALL incoming SMS messages
 */
async function processIncomingMessage(phone, text, twilioSid) {
    try {
        // Normalize phone number
        const normalizedPhone = normalizePhone(phone);

        // Find user
        const userResult = await db.query(
            'SELECT * FROM users WHERE phone_number = $1 AND active = true',
            [normalizedPhone]
        );

        if (!userResult.rows[0]) {
            console.log(`⚠️ Unknown phone: ${normalizedPhone}`);
            return;
        }
        const user = userResult.rows[0];

        // Get conversation state
        const stateResult = await db.query(
            'SELECT * FROM conversation_state WHERE user_id = $1',
            [user.id]
        );
        const state = stateResult.rows[0] || { stage: 'idle', context: {} };
        const context = typeof state.context === 'string' ? JSON.parse(state.context) : state.context;

        // Log the incoming message
        await db.query(
            `INSERT INTO messages (user_id, session_id, direction, content, message_type, twilio_sid)
       VALUES ($1, $2, 'incoming', $3, 'response', $4)`,
            [user.id, context.sessionId || null, text, twilioSid || null]
        );

        console.log(`📩 Message from ${user.name} [${state.stage}]: "${text}"`);

        // Route based on conversation stage
        await routeMessage(user, text, state.stage, context);
    } catch (err) {
        console.error('❌ processIncomingMessage error:', err.message);
    }
}

/**
 * Route message based on current conversation state
 */
async function routeMessage(user, text, stage, context) {
    const intent = await parseUserIntent(text, { stage });

    switch (stage) {
        case 'awaiting_goal':
            return handleGoalInput(user, text);

        case 'awaiting_time':
            return handleTimeInput(user, text, context);

        case 'session_check':
            return handleSessionCheck(user, intent, context);

        case 'awaiting_accomplishments':
            return handleAccomplishmentsInput(user, text, context);

        case 'awaiting_reschedule':
            return handleRescheduleInput(user, text, context);

        case 'idle':
        default:
            return handleIdleMessage(user, text, intent);
    }
}

/**
 * Handle goal input (step 1 of morning check-in flow)
 */
async function handleGoalInput(user, goal) {
    // Store goal temporarily in context
    await db.query(
        `INSERT INTO conversation_state (user_id, stage, context)
     VALUES ($1, 'awaiting_time', $2)
     ON CONFLICT (user_id) DO UPDATE SET stage = 'awaiting_time', context = $2, updated_at = NOW()`,
        [user.id, JSON.stringify({ goal })]
    );

    const message = await generateCheckin({
        user,
        session: { goal },
        stage: 'awaiting_time',
    });

    await sendSMS(user.phone_number, message, {
        userId: user.id,
        messageType: 'response',
    });
}

/**
 * Handle time slot input (step 2 of morning check-in flow)
 */
async function handleTimeInput(user, timeText, context) {
    const goal = context.goal || 'your work';

    // Parse the time from the user's reply
    const scheduledTime = parseTimeInput(timeText, user.timezone);

    if (!scheduledTime) {
        await sendSMS(user.phone_number,
            `Hmm, I couldn't figure out that time. Try something like "2pm", "14:00", or "in 2 hours".`,
            { userId: user.id, messageType: 'response' }
        );
        return;
    }

    // Create the session
    const session = await scheduleSession(user.id, goal, scheduledTime.toDate());

    // Confirm to user
    const confirmTime = scheduledTime.tz(user.timezone).format('h:mm A');
    const confirmMessages = {
        cheerleader: `Let's GO! I've got "${goal}" locked in for ${confirmTime}. You're going to crush it! 🎯`,
        coach: `Got it. "${goal}" at ${confirmTime}. I'll check in then. Ready to start strong.`,
        gentle: `Perfect. I've noted "${goal}" for ${confirmTime}. I'll be here to gently nudge you when it's time. 💙`,
    };

    const confirmMsg = confirmMessages[user.tone_preference] || confirmMessages.coach;
    await sendSMS(user.phone_number, confirmMsg, {
        userId: user.id,
        sessionId: session.id,
        messageType: 'response',
    });

    // Reset to idle
    await db.query(
        `UPDATE conversation_state SET stage = 'idle', context = '{}', updated_at = NOW() WHERE user_id = $1`,
        [user.id]
    );
}

/**
 * Handle session start check (yes / need 5 min / can't today)
 */
async function handleSessionCheck(user, intent, context) {
    const sessionId = context.sessionId;

    // Verify session exists
    const { rows } = await db.query(
        'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
        [sessionId, user.id]
    );
    if (!rows[0]) return;
    const session = rows[0];

    switch (intent.intent) {
        case 'yes':
        case 'need_5min': {
            if (intent.intent === 'yes') {
                await activateSession(sessionId, user.id);
                await db.query(
                    `UPDATE conversation_state SET stage = 'active_session', context = $1, updated_at = NOW() WHERE user_id = $2`,
                    [JSON.stringify({ sessionId }), user.id]
                );

                const startMessages = {
                    cheerleader: `Timer started! You've GOT this. Go! ⏱️🔥`,
                    coach: `Timer started. Focus up. Go.`,
                    gentle: `Timer's running. Take a breath and dive in. I'll check on you soon. 💚`,
                };
                await sendSMS(user.phone_number, startMessages[user.tone_preference] || startMessages.coach, {
                    userId: user.id, sessionId, messageType: 'session_start',
                });
            } else {
                // Need 5 minutes
                const message = await generateCheckin({ user, session, stage: 'needs_5min' });
                await sendSMS(user.phone_number, message, {
                    userId: user.id, sessionId, messageType: 'response',
                });
                // Schedule re-check in 5 minutes
                setTimeout(async () => {
                    const { generateCheckin: gc } = require('./aiService');
                    const { sendSMS: sms } = require('./smsService');
                    const msg = await gc({ user, session, stage: 'session_start' });
                    await sms(user.phone_number, msg, { userId: user.id, sessionId, messageType: 'session_start' });
                }, 5 * 60 * 1000);
            }
            break;
        }

        case 'cant_today':
        case 'no': {
            const message = await generateCheckin({ user, session, stage: 'reschedule' });
            await sendSMS(user.phone_number, message, {
                userId: user.id, sessionId, messageType: 'response',
            });

            await db.query(
                `INSERT INTO conversation_state (user_id, stage, context)
         VALUES ($1, 'awaiting_reschedule', $2)
         ON CONFLICT (user_id) DO UPDATE SET stage = 'awaiting_reschedule', context = $2, updated_at = NOW()`,
                [user.id, JSON.stringify({ sessionId, goal: session.goal })]
            );
            break;
        }

        default: {
            // Unclear - re-prompt
            await sendSMS(user.phone_number,
                `Reply with:\n• Yes – start now\n• Need 5 min – give me a moment\n• Can't today – reschedule`,
                { userId: user.id, sessionId, messageType: 'response' }
            );
        }
    }
}

/**
 * Handle accomplishments input at end of session
 */
async function handleAccomplishmentsInput(user, accomplishments, context) {
    const sessionId = context.sessionId;
    await handleAccomplishments(user.id, sessionId, accomplishments);
}

/**
 * Handle reschedule input
 */
async function handleRescheduleInput(user, timeText, context) {
    const { sessionId, goal } = context;

    // Cancel old session
    await db.query(
        'UPDATE sessions SET status = $1 WHERE id = $2',
        ['cancelled', sessionId]
    );

    const scheduledTime = parseTimeInput(timeText, user.timezone);
    if (!scheduledTime || !scheduledTime.isValid()) {
        const tomorrow9am = dayjs().tz(user.timezone).add(1, 'day').hour(9).minute(0).second(0);
        const session = await scheduleSession(user.id, goal, tomorrow9am.toDate());

        await sendSMS(user.phone_number,
            `No worries! I've rescheduled "${goal}" for tomorrow at 9am. Rest up! 💙`,
            { userId: user.id, sessionId: session.id, messageType: 'response' }
        );
    } else {
        const session = await scheduleSession(user.id, goal, scheduledTime.toDate());
        const confirmTime = scheduledTime.tz(user.timezone).format('h:mm A, MMM D');

        await sendSMS(user.phone_number,
            `Rescheduled! "${goal}" is now set for ${confirmTime}. See you then!`,
            { userId: user.id, sessionId: session.id, messageType: 'response' }
        );
    }

    await db.query(
        `UPDATE conversation_state SET stage = 'idle', context = '{}', updated_at = NOW() WHERE user_id = $1`,
        [user.id]
    );
}

/**
 * Handle messages when user is in idle state (no active conversation)
 */
async function handleIdleMessage(user, text, intent) {
    const lower = text.toLowerCase().trim();

    if (lower === 'help' || lower === '?') {
        await sendSMS(user.phone_number,
            `FlowState commands:\n• "Start" – begin a new session\n• "Status" – see today's sessions\n• "Stop" – cancel current session\n• "Help" – this menu`,
            { userId: user.id, messageType: 'general' }
        );
        return;
    }

    if (lower === 'start' || lower === 'new session') {
        // Initiate a new session manually
        await db.query(
            `INSERT INTO conversation_state (user_id, stage, context)
       VALUES ($1, 'awaiting_goal', '{}')
       ON CONFLICT (user_id) DO UPDATE SET stage = 'awaiting_goal', context = '{}', updated_at = NOW()`,
            [user.id]
        );

        const message = await generateCheckin({ user, session: null, stage: 'morning_checkin' });
        await sendSMS(user.phone_number, message, { userId: user.id, messageType: 'morning_checkin' });
        return;
    }

    if (lower === 'status') {
        const { rows } = await db.query(
            `SELECT goal, scheduled_time, status FROM sessions
       WHERE user_id = $1 AND scheduled_time > NOW() - INTERVAL '24 hours'
       ORDER BY scheduled_time DESC LIMIT 5`,
            [user.id]
        );

        if (rows.length === 0) {
            await sendSMS(user.phone_number,
                `No sessions scheduled yet. Reply "Start" to set up a new session!`,
                { userId: user.id, messageType: 'general' }
            );
        } else {
            const statusText = rows.map(s =>
                `• ${s.goal} (${dayjs(s.scheduled_time).tz(user.timezone).format('h:mma')}) – ${s.status}`
            ).join('\n');
            await sendSMS(user.phone_number, `Your recent sessions:\n${statusText}`, {
                userId: user.id, messageType: 'general',
            });
        }
        return;
    }

    // Default: friendly response
    await sendSMS(user.phone_number,
        `Hey ${user.name}! Reply "Start" to begin a new focus session, or "Help" for all options.`,
        { userId: user.id, messageType: 'general' }
    );
}

/**
 * Parse natural language time input
 */
function parseTimeInput(text, userTimezone) {
    const tz = userTimezone || 'America/New_York';
    const now = dayjs().tz(tz);
    const lower = text.toLowerCase().trim();

    // "in X hours/minutes"
    const inMinutes = lower.match(/in\s+(\d+)\s+min/);
    const inHours = lower.match(/in\s+(\d+)\s+hour/);
    if (inMinutes) return now.add(parseInt(inMinutes[1]), 'minute');
    if (inHours) return now.add(parseInt(inHours[1]), 'hour');

    // "tomorrow"
    if (lower.includes('tomorrow')) {
        const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
        if (timeMatch) {
            const [, h, m = '00', ampm] = timeMatch;
            let hour = parseInt(h);
            if (ampm === 'pm' && hour !== 12) hour += 12;
            if (ampm === 'am' && hour === 12) hour = 0;
            return now.add(1, 'day').hour(hour).minute(parseInt(m)).second(0);
        }
        return now.add(1, 'day').hour(9).minute(0).second(0);
    }

    // "now"
    if (lower === 'now' || lower === 'right now') {
        return now.add(1, 'minute');
    }

    // Try to parse common time formats: "2pm", "14:00", "2:30 pm"
    const formats = ['h:mm A', 'h:mmA', 'H:mm', 'h A', 'hA', 'h:mm a', 'h a'];
    for (const fmt of formats) {
        const parsed = dayjs.tz(text, fmt, tz);
        if (parsed.isValid()) {
            // If time is in the past today, assume tomorrow
            if (parsed.isBefore(now)) return parsed.add(1, 'day');
            return parsed;
        }
    }

    // Try basic regex: "2pm", "3:30pm", "14:00"
    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/);
    if (timeMatch) {
        const [, h, m = '00', ampm] = timeMatch;
        let hour = parseInt(h);
        if (ampm && ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
        if (ampm && ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
        let result = now.hour(hour).minute(parseInt(m)).second(0);
        if (result.isBefore(now)) result = result.add(1, 'day');
        return result;
    }

    return null;
}

function normalizePhone(phone) {
    // Ensure E.164 format
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
}

module.exports = { processIncomingMessage };
