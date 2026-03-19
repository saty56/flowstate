const axios = require('axios');
const db = require('../db');
const { google, oauth2Client } = require('../utils/googleAuth');

/**
 * Fetch open tasks from Todoist
 * @param {string} token - Todoist API token
 */
async function getTodoistTasks(token) {
    try {
        const response = await axios.get('https://api.todoist.com/rest/v2/tasks', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data;
    } catch (err) {
        console.error('Todoist API error:', err.response?.data || err.message);
        throw new Error('Failed to fetch Todoist tasks');
    }
}

/**
 * Get Todoist tasks for a specific user
 * @param {string} userId 
 */
async function getUserTodoistTasks(userId) {
    const { rows } = await db.query('SELECT todoist_token FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !rows[0].todoist_token) {
        return [];
    }
    return await getTodoistTasks(rows[0].todoist_token);
}

/**
 * Fetch calendar events from Google
 * @param {string} refreshToken 
 */
async function getGoogleCalendarEvents(refreshToken) {
    try {
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date().toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });
        
        return response.data.items;
    } catch (err) {
        console.error('Google Calendar API error:', err);
        return [];
    }
}

/**
 * Get Google events for a specific user
 * @param {string} userId 
 */
async function getUserGoogleEvents(userId) {
    const { rows } = await db.query('SELECT google_refresh_token FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !rows[0].google_refresh_token) {
        return [];
    }
    return await getGoogleCalendarEvents(rows[0].google_refresh_token);
}

module.exports = {
    getTodoistTasks,
    getUserTodoistTasks,
    getGoogleCalendarEvents,
    getUserGoogleEvents
};
