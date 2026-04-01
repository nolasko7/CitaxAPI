const DEFAULT_SUPERADMIN_EMAIL = "superadmin@citax.local";
const DEFAULT_SUPERADMIN_PASSWORD = "citax-superadmin";

function normalizeCredentialValue(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeCredentialValue(value).toLowerCase();
}

function getSuperadminCredentials(env = process.env) {
  const rawEmail = env.SUPERADMIN_EMAIL;
  const rawPassword = env.SUPERADMIN_PASSWORD;

  return {
    email: normalizeEmail(rawEmail || DEFAULT_SUPERADMIN_EMAIL),
    password: normalizeCredentialValue(rawPassword || DEFAULT_SUPERADMIN_PASSWORD),
    secret:
      normalizeCredentialValue(env.SUPERADMIN_JWT_SECRET) ||
      normalizeCredentialValue(env.JWT_SECRET) ||
      "superadmin-secret",
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
