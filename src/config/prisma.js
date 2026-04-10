require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const dbHost = process.env.DB_HOST;
const dbPort = process.env.DB_PORT || 4000;
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;
const dbName = process.env.DB_NAME;
const currentDatabaseUrl = String(process.env.DATABASE_URL || '').trim();

const buildFallbackDatabaseUrl = () => {
  if (!dbHost || !dbPort || !dbUser || dbPass === undefined || !dbName) {
    return null;
  }

  const encodedUser = encodeURIComponent(dbUser);
  const encodedPass = encodeURIComponent(dbPass);
  return `mysql://${encodedUser}:${encodedPass}@${dbHost}:${dbPort}/${dbName}?sslaccept=strict`;
};

const shouldReplaceDatabaseUrl = (url) => {
  if (!url) return true;

  const normalized = url.toLowerCase();
  return (
    normalized.includes('user:password@host:port') ||
    normalized.includes('mysql://user:password@host:port/db')
  );
};

// Prisma depends on DATABASE_URL, but local runtime may only have DB_* vars
// or a placeholder DATABASE_URL committed for reference.
if (shouldReplaceDatabaseUrl(currentDatabaseUrl)) {
  const fallbackDatabaseUrl = buildFallbackDatabaseUrl();
  if (fallbackDatabaseUrl) {
    process.env.DATABASE_URL = fallbackDatabaseUrl;
  }
}

const prisma = new PrismaClient();

module.exports = prisma;
