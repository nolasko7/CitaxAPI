const DEFAULT_SUPERADMIN_EMAIL = "superadmin@citax.local";
const DEFAULT_SUPERADMIN_PASSWORD = "citax-superadmin";
const DEFAULT_SUPERADMIN_SECRET = "superadmin-secret";
const DEFAULT_SUPPORT_INSTANCE = "citax-support-whatsapp";

function normalizeCredentialValue(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeCredentialValue(value).toLowerCase();
}

function getFirstDefinedValue(env, keys) {
  for (const key of keys) {
    const value = normalizeCredentialValue(env[key]);
    if (value) return value;
  }
  return "";
}

function getSuperadminCredentials(env = process.env) {
  const rawEmail = getFirstDefinedValue(env, [
    "SUPERADMIN_EMAIL",
    "SUPERADMIN_USER",
  ]);
  const rawPassword = getFirstDefinedValue(env, [
    "SUPERADMIN_PASSWORD",
    "SUPERADMIN_PASS",
  ]);
  const rawSecret = getFirstDefinedValue(env, [
    "SUPERADMIN_JWT_SECRET",
    "SUPERADMIN_SECRET",
    "JWT_SECRET",
  ]);
  const rawSupportInstance = getFirstDefinedValue(env, [
    "SUPPORT_WHATSAPP_INSTANCE",
    "SUPERADMIN_WA_INSTANCE",
  ]);

  return {
    email: normalizeEmail(rawEmail || DEFAULT_SUPERADMIN_EMAIL),
    password: normalizeCredentialValue(rawPassword || DEFAULT_SUPERADMIN_PASSWORD),
    secret: rawSecret || DEFAULT_SUPERADMIN_SECRET,
    supportInstance: rawSupportInstance || DEFAULT_SUPPORT_INSTANCE,
    usingDefaults: !rawEmail || !rawPassword,
  };
}

module.exports = {
  DEFAULT_SUPERADMIN_EMAIL,
  DEFAULT_SUPERADMIN_PASSWORD,
  getSuperadminCredentials,
  normalizeCredentialValue,
  normalizeEmail,
};
