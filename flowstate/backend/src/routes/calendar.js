const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const db = require('../db');

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

/**
 * GET /api/calendar/callback
 * Handle Google OAuth2 callback
 */
router.get('/callback', async (req, res) => {
    const { code, state: userId } = req.query;

    if (!code) {
        return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?error=no_code`);
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        // Store the refresh token in the database
        if (tokens.refresh_token) {
            await db.query(
                'UPDATE users SET google_refresh_token = $1 WHERE id = $2',
                [tokens.refresh_token, userId]
            );
        } else {
            // Note: refresh_token is only sent on the first authorization
            console.log('No refresh token received. User might have authorized previously.');
        }

        res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?userId=${userId}&sync=google_success`);
    } catch (err) {
        console.error('Google OAuth Error:', err);
        res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?userId=${userId}&error=google_failed`);
    }
});

module.exports = router;
