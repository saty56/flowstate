require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const axios = require('axios');
const { google, oauth2Client } = require('../utils/googleAuth');

// Separate OAuth2 client specifically for Auth (login/signup)
// The main oauth2Client is configured for Calendar, this one is for Auth
const { OAuth2Client } = require('google-auth-library');
const authOAuth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_AUTH_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback'
);

const JWT_SECRET = process.env.SESSION_SECRET || 'flowstate-super-secret-session-key-change-this';

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        // Check if email already exists
        const { rows: existingUsers } = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ error: 'User with this email already exists' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        // Insert new user
        const { rows: newUsers } = await db.query(
            `INSERT INTO users (name, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, name, email, onboarded`,
            [name, email, password_hash]
        );

        const user = newUsers[0];

        // Setup initial default preferences
        await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1)`, [user.id]);
        await db.query(`INSERT INTO conversation_state (user_id) VALUES ($1)`, [user.id]);

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ user, token });

    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user by email
        const { rows: users } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = users[0];

        if (!user || !user.password_hash) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Check password
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

        // Remove sensitive data before sending
        delete user.password_hash;
        delete user.google_refresh_token;
        delete user.todoist_token;

        res.json({ user, token });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Shared helper for social user management
 */
async function handleSocialUser(res, provider, externalId, email, name, avatarUrl) {
    const idColumn = `${provider}_id`;
    let user;

    try {
        // 1. Find by social ID
        const { rows: idRows } = await db.query(`SELECT * FROM users WHERE ${idColumn} = $1`, [externalId]);
        
        if (idRows.length > 0) {
            user = idRows[0];
        } else {
            // 2. Find by email
            const { rows: emailRows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
            
            if (emailRows.length > 0) {
                // Update social ID and avatar, then re-fetch fresh user data
                await db.query(`UPDATE users SET ${idColumn} = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3`, [externalId, avatarUrl, emailRows[0].id]);
                const { rows: refreshed } = await db.query('SELECT * FROM users WHERE id = $1', [emailRows[0].id]);
                user = refreshed[0];
            } else {
                // 3. Create NEW user
                const { rows: newUsers } = await db.query(
                    `INSERT INTO users (name, email, ${idColumn}, avatar_url, onboarded) 
                     VALUES ($1, $2, $3, $4, false) RETURNING *`,
                    [name || email.split('@')[0], email, externalId, avatarUrl]
                );
                user = newUsers[0];
                await db.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [user.id]);
                await db.query('INSERT INTO conversation_state (user_id) VALUES ($1)', [user.id]);
            }
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        const isOnboarded = user.onboarded === true;
        console.log(`✅ Social auth success: ${email}, onboarded: ${isOnboarded}, userId: ${user.id}`);
        
        // Conditional redirect using Hash Fragment (#)
        if (isOnboarded) {
            res.redirect(`${process.env.FRONTEND_URL}/dashboard.html#userId=${user.id}&token=${token}`);
        } else {
            res.redirect(`${process.env.FRONTEND_URL}/onboard.html#userId=${user.id}&token=${token}`);
        }
    } catch (err) {
        console.error('Social Auth Flow Error:', err);
        res.redirect(`${process.env.FRONTEND_URL}/login.html#error=social_failed`);
    }
}

// GET /api/auth/google
router.get('/google', (req, res) => {
    const url = authOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['profile', 'email'],
        prompt: 'select_account'
    });
    res.redirect(url);
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=no_code`);

    try {
        const { tokens } = await authOAuth2Client.getToken(code);
        authOAuth2Client.setCredentials(tokens);
        
        const { data } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        
        await handleSocialUser(res, 'google', data.sub, data.email, data.name, data.picture);
    } catch (err) {
        console.error('Google Auth Error:', err);
        res.redirect(`${process.env.FRONTEND_URL}/login.html?error=google_failed`);
    }
});

// GET /api/auth/github
router.get('/github', (req, res) => {
    const url = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=user:email`;
    res.redirect(url);
});

// GET /api/auth/github/callback
router.get('/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=no_code`);

    try {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code
        }, { headers: { 'Accept': 'application/json' } });

        const githubToken = tokenRes.data.access_token;
        if (!githubToken) {
            console.error('GitHub: No access token received', tokenRes.data);
            return res.redirect(`${process.env.FRONTEND_URL}/login.html?error=github_no_token`);
        }
        
        const userRes = await axios.get('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${githubToken}` }
        });
        
        // Get email - try user profile first, then emails endpoint
        let primaryEmail = userRes.data.email;
        if (!primaryEmail) {
            try {
                const emailRes = await axios.get('https://api.github.com/user/emails', {
                    headers: { 'Authorization': `Bearer ${githubToken}` }
                });
                const primary = emailRes.data.find(e => e.primary && e.verified);
                primaryEmail = primary ? primary.email : emailRes.data[0]?.email;
            } catch (emailErr) {
                console.error('GitHub: Could not fetch emails', emailErr.message);
            }
        }

        if (!primaryEmail) {
            console.error('GitHub: no email found for user', userRes.data.login);
            // Use a synthetic email based on GitHub username as fallback
            primaryEmail = `${userRes.data.login}@github.local`;
        }

        console.log(`GitHub callback: user=${userRes.data.login}, email=${primaryEmail}`);
        await handleSocialUser(res, 'github', userRes.data.id.toString(), primaryEmail, userRes.data.name || userRes.data.login, userRes.data.avatar_url);
    } catch (err) {
        console.error('GitHub Auth Error:', err.message);
        res.redirect(`${process.env.FRONTEND_URL}/login.html?error=github_failed`);
    }
});

module.exports = router;

