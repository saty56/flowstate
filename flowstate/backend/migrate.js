const db = require('./src/db');

async function migrate() {
    try {
        await db.query(`ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL`);
        console.log("phone_number constraint dropped");
    } catch (e) { console.log(e.message); }

    try {
        await db.query(`ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE`);
        console.log("email added");
    } catch (e) { console.log(e.message); }

    try {
        await db.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)`);
        console.log("password_hash added");
    } catch (e) { console.log(e.message); }

    console.log("Done");
    process.exit(0);
}

migrate();
