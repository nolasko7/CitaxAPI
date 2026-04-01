const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPhoneVariants,
  getConfiguredSupportPhones,
  getIgnoredInternalPhonesForInstance,
  normalizeWhatsappPhone,
  setSupportInstancePhone,
} = require("../src/services/internalWhatsapp.service");

test("normalizeWhatsappPhone strips symbols and spaces", () => {
  assert.equal(normalizeWhatsappPhone("+54 9 2657-359495"), "5492657359495");
});

test("buildPhoneVariants returns 54 and 549 variants", () => {
  const variants = buildPhoneVariants("5492657359495");

  assert.deepEqual(
    variants.sort(),
    ["542657359495", "5492657359495"].sort(),
  );
});

test("getConfiguredSupportPhones merges env aliases and runtime support phone", () => {
  setSupportInstancePhone("5492657000000");
  const phones = getConfiguredSupportPhones({
    SUPPORT_WHATSAPP_NUMBER: "542657111111",
  });

  assert.equal(phones.has("5492657000000"), true);
  assert.equal(phones.has("542657000000"), true);
  assert.equal(phones.has("542657111111"), true);
  assert.equal(phones.has("5492657111111"), true);

  setSupportInstancePhone("");
});

test("getIgnoredInternalPhonesForInstance is directional by instance", () => {
  const supportPhones = new Set(["5492657000000"]);
  const companyPhones = new Set(["5492657111111", "5492657222222"]);

  const supportIgnored = getIgnoredInternalPhonesForInstance({
    currentInstanceName: "citax-support-whatsapp",
    supportInstanceName: "citax-support-whatsapp",
    supportPhones,
    companyPhones,
  });

  const companyIgnored = getIgnoredInternalPhonesForInstance({
    currentInstanceName: "citax-empresa-2-whatsapp",
    supportInstanceName: "citax-support-whatsapp",
    supportPhones,
    companyPhones,
  });

  assert.deepEqual([...supportIgnored].sort(), [...companyPhones].sort());
  assert.deepEqual([...companyIgnored], [...supportPhones]);
});
