const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_EVOLUTION_API_KEY,
  DEFAULT_EVOLUTION_API_URL,
  getEvolutionApiConfig,
  getEvolutionRequestHeaders,
} = require("../src/services/evolutionConfig.service");

test("getEvolutionApiConfig trims configured Evolution credentials", () => {
  const config = getEvolutionApiConfig({
    EVOLUTION_API_URL: " https://evo.citax.com.ar/ ",
    EVOLUTION_API_KEY: "  mi-api-key  ",
  });

  assert.equal(config.baseUrl, "https://evo.citax.com.ar/");
  assert.equal(config.apiKey, "mi-api-key");
  assert.equal(config.usingDefaultApiKey, false);
});

test("getEvolutionApiConfig falls back to the shared default api key", () => {
  const config = getEvolutionApiConfig({});

  assert.equal(config.baseUrl, DEFAULT_EVOLUTION_API_URL);
  assert.equal(config.apiKey, DEFAULT_EVOLUTION_API_KEY);
  assert.equal(config.usingDefaultApiKey, true);
});

test("getEvolutionRequestHeaders builds the same auth headers for Evolution requests", () => {
  const headers = getEvolutionRequestHeaders({
    EVOLUTION_API_KEY: "abc123",
  });

  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    apikey: "abc123",
    Authorization: "Bearer abc123",
  });
});
