const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getSingleProviderModeActivationStatus,
  isSingleProviderModeEnabledForConfig,
  normalizeOwnPhrasesConfig,
  parseBotConfig,
  sanitizeBotConfig,
} = require("../src/services/singleProviderMode.service");

test("parseBotConfig returns empty object for invalid payloads", () => {
  assert.deepEqual(parseBotConfig(null), {});
  assert.deepEqual(parseBotConfig("no-json"), {});
  assert.deepEqual(parseBotConfig([]), {});
});

test("sanitizeBotConfig forces first person when single provider mode is enabled", () => {
  const config = sanitizeBotConfig({
    rubro: "Peluqueria",
    primera_persona: false,
    cuenta_prestador_unico: true,
  });

  assert.equal(config.rubro, "Peluqueria");
  assert.equal(config.cuenta_prestador_unico, true);
  assert.equal(config.primera_persona, true);
});

test("normalizeOwnPhrasesConfig preserves legacy strings as general phrases", () => {
  assert.deepEqual(normalizeOwnPhrasesConfig("Usa amigaso al saludar"), {
    general: "Usa amigaso al saludar",
    saludos: "",
    confirmaciones: "",
    cierres: "",
  });
});

test("sanitizeBotConfig stores structured own phrases by context", () => {
  const config = sanitizeBotConfig({
    palabras_propias_general: "Deci corte en vez de servicio.",
    palabras_propias_saludos: "Usa amigaso al saludar.",
    palabras_propias_confirmaciones: "Cuando confirmes, deci de una.",
    palabras_propias_cierres: "Para cerrar, usa abrazo grande.",
  });

  assert.deepEqual(config.palabras_propias, {
    general: "Deci corte en vez de servicio.",
    saludos: "Usa amigaso al saludar.",
    confirmaciones: "Cuando confirmes, deci de una.",
    cierres: "Para cerrar, usa abrazo grande.",
  });
});

test("isSingleProviderModeEnabledForConfig reads the bot config flag", () => {
  assert.equal(isSingleProviderModeEnabledForConfig({ cuenta_prestador_unico: true }), true);
  assert.equal(isSingleProviderModeEnabledForConfig({ cuenta_prestador_unico: false }), false);
});

test("getSingleProviderModeActivationStatus allows activation with zero or one provider", () => {
  assert.equal(getSingleProviderModeActivationStatus(0).allowed, true);
  assert.equal(getSingleProviderModeActivationStatus(1).allowed, true);
});

test("getSingleProviderModeActivationStatus blocks activation with multiple providers", () => {
  const status = getSingleProviderModeActivationStatus(2);
  assert.equal(status.allowed, false);
  assert.match(status.reason, /más de un prestador/i);
});
