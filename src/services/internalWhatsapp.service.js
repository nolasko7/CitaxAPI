const SUPPORT_PHONE_ENV_KEYS = [
  "SUPPORT_WHATSAPP_NUMBER",
  "SUPERADMIN_WA_NUMBER",
  "SUPERADMIN_WHATSAPP_NUMBER",
];

let runtimeSupportPhone = "";

const normalizeWhatsappPhone = (value) =>
  String(value || "").replace(/[^\d]/g, "").trim();

const buildPhoneVariants = (value) => {
  const digits = normalizeWhatsappPhone(value);
  if (!digits) return [];

  const variants = new Set([digits]);

  if (digits.startsWith("549") && digits.length >= 12) {
    variants.add(`54${digits.slice(3)}`);
  }

  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length >= 11) {
    variants.add(`549${digits.slice(2)}`);
  }

  return [...variants];
};

const setSupportInstancePhone = (value) => {
  runtimeSupportPhone = normalizeWhatsappPhone(value);
  return runtimeSupportPhone;
};

const normalizeInternalInstanceName = (value) =>
  String(value || "").trim().toLowerCase();

const getConfiguredSupportPhones = (env = process.env) => {
  const rawPhones = new Set();

  for (const key of SUPPORT_PHONE_ENV_KEYS) {
    const digits = normalizeWhatsappPhone(env[key]);
    if (digits) {
      rawPhones.add(digits);
    }
  }

  if (runtimeSupportPhone) {
    rawPhones.add(runtimeSupportPhone);
  }

  const variants = new Set();
  for (const rawPhone of rawPhones) {
    for (const candidate of buildPhoneVariants(rawPhone)) {
      variants.add(candidate);
    }
  }

  return variants;
};

const getIgnoredInternalPhonesForInstance = ({
  currentInstanceName,
  supportInstanceName,
  supportPhones = new Set(),
  companyPhones = new Set(),
}) => {
  const normalizedCurrentInstance = normalizeInternalInstanceName(currentInstanceName);
  const normalizedSupportInstance = normalizeInternalInstanceName(
    supportInstanceName
  );

  if (!normalizedCurrentInstance) {
    return new Set();
  }

  if (normalizedCurrentInstance === normalizedSupportInstance) {
    return new Set(companyPhones);
  }

  return new Set(supportPhones);
};

module.exports = {
  buildPhoneVariants,
  getConfiguredSupportPhones,
  getIgnoredInternalPhonesForInstance,
  normalizeWhatsappPhone,
  setSupportInstancePhone,
};
