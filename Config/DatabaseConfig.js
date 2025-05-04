import { MongoClient } from 'mongodb';
const MONGO_URL = 'mongodb+srv://sangngo552004:SANG0968478424@production-management.xvgdy1a.mongodb.net/?retryWrites=true&w=majority&appName=production-management'
const client = new MongoClient(MONGO_URL);

let db;

export async function connectDB() {
  await client.connect();
  db = client.db('chat-box');
  console.log('✅ Connected to MongoDB');
}

export function getDB() {
  if (!db) throw new Error('Database not connected');
  return db;
}

