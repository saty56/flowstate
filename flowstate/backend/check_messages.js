require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 10"))
  .then(res => { 
    if (res.rows.length === 0) {
      console.log('No messages found in DB.');
    } else {
      console.table(res.rows);
    }
    return client.end(); 
  })
  .catch(console.error);
