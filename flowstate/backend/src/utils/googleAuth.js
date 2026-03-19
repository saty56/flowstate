require('dotenv').config();
const { google } = require('googleapis');

if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('❌ GOOGLE_CLIENT_ID is missing from .env');
}


const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

module.exports = {
    oauth2Client,
    google
};
