const {
  parseBotConfig,
} = require("../services/singleProviderMode.service");

const KNOWN_LANDING_TEMPLATES = new Set(["sergio-pereira", "pepardo", "unvimesi"]);

const normalizeComparableText = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const resolveImplicitLandingTemplate = ({ slug, nombre_comercial }) => {
  const normalizedSlug = normalizeComparableText(slug).replace(/\s+/g, "-");
  const normalizedName = normalizeComparableText(nombre_comercial);

  if (normalizedSlug === "sergiopereira") {
    return "sergio-pereira";
  }

  if (normalizedName.includes("sergio pereira")) {
    return "sergio-pereira";
  }

  if (normalizedSlug === "pepardo") {
    return "pepardo";
  }

  if (normalizedSlug === "unvimesi" || normalizedSlug === "unvime-si") {
    return "unvimesi";
  }

  if (normalizedName.includes("unvimesi") || normalizedName.includes("unvime si")) {
    return "unvimesi";
  }

  return null;
};

const resolveCompanyLandingTemplate = (company = {}) => {
  const botConfig = parseBotConfig(company.bot_config);
  const configuredTemplate = String(botConfig?.landing_template || "")
    .trim()
    .toLowerCase();

  if (KNOWN_LANDING_TEMPLATES.has(configuredTemplate)) {
    return configuredTemplate;
  }

  return resolveImplicitLandingTemplate(company);
};

const attachLandingTemplateToBotConfig = (company = {}) => {
  const landingTemplate = resolveCompanyLandingTemplate(company);
  const botConfig = parseBotConfig(company.bot_config);

  if (!landingTemplate) {
    return {
      landingTemplate: null,
      botConfig,
      shouldPersist: false,
    };
  }

  if (botConfig.landing_template === landingTemplate) {
    return {
      landingTemplate,
      botConfig,
      shouldPersist: false,
    };
  }

  return {
    landingTemplate,
    botConfig: {
      ...botConfig,
      landing_template: landingTemplate,
    },
    shouldPersist: true,
  };
};

module.exports = {
  KNOWN_LANDING_TEMPLATES,
  attachLandingTemplateToBotConfig,
  normalizeComparableText,
  resolveCompanyLandingTemplate,
};
