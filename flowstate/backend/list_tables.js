require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"))
  .then(res => { 
    console.log('Tables:', res.rows.map(r => r.table_name).join(', '));
    return client.end(); 
  })
  .catch(console.error);
