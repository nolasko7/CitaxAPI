const DEFAULT_EVOLUTION_API_URL = "http://localhost:8080";
const DEFAULT_EVOLUTION_API_KEY = "429683C4C977415CAAFCCE10F7D57E11";

const normalizeEnvValue = (value) => String(value || "").trim();

const getEvolutionApiConfig = (env = process.env) => {
  const configuredBaseUrl = normalizeEnvValue(env.EVOLUTION_API_URL);
  const configuredApiKey = normalizeEnvValue(env.EVOLUTION_API_KEY);

  return {
    baseUrl: configuredBaseUrl || DEFAULT_EVOLUTION_API_URL,
    apiKey: configuredApiKey || DEFAULT_EVOLUTION_API_KEY,
    usingDefaultApiKey: !configuredApiKey,
  };
};

const getEvolutionRequestHeaders = (env = process.env) => {
  const { apiKey } = getEvolutionApiConfig(env);
  const headers = {
    "Content-Type": "application/json",
  };

  if (!apiKey) {
    return headers;
  }

  return {
    ...headers,
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
};

module.exports = {
  DEFAULT_EVOLUTION_API_URL,
  DEFAULT_EVOLUTION_API_KEY,
  getEvolutionApiConfig,
  getEvolutionRequestHeaders,
};
