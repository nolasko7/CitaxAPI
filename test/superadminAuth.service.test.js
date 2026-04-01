const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SUPERADMIN_EMAIL,
  DEFAULT_SUPERADMIN_PASSWORD,
  getSuperadminCredentials,
  normalizeCredentialValue,
  normalizeEmail,
} = require("../src/services/superadminAuth.service");

test("getSuperadminCredentials uses defaults when env vars are missing", () => {
  const credentials = getSuperadminCredentials({});

  assert.equal(credentials.email, DEFAULT_SUPERADMIN_EMAIL);
  assert.equal(credentials.password, DEFAULT_SUPERADMIN_PASSWORD);
  assert.equal(credentials.usingDefaults, true);
});

test("getSuperadminCredentials trims and normalizes configured credentials", () => {
  const credentials = getSuperadminCredentials({
    SUPERADMIN_EMAIL: "  ADMIN@CITAX.COM.AR  ",
    SUPERADMIN_PASSWORD: "  seCreta123  ",
    SUPERADMIN_JWT_SECRET: "  jwt-secret  ",
  });

  assert.equal(credentials.email, "admin@citax.com.ar");
  assert.equal(credentials.password, "seCreta123");
  assert.equal(credentials.secret, "jwt-secret");
  assert.equal(credentials.usingDefaults, false);
});

test("normalize helpers sanitize raw login values", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(normalizeCredentialValue("  clave123  "), "clave123");
});
