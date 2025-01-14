// services/db.js
require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;

let db = null;
const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });

async function connectMongo() {
    if (db) return db;
    try {
        await client.connect();
        db = client.db();
        console.log("✅ Verbonden met MongoDB");

        // Creëer een TTL-index op het veld 'createdAt' dat verwijdert na 24 uur (86400 seconden)
        const coll = db.collection("auditCache");
        await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });

        return db;
    } catch (err) {
        console.error("Fout bij verbinden met MongoDB:", err.message);
        process.exit(1);
    }
}

module.exports = { connectMongo };
