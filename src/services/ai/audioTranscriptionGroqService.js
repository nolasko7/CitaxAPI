const axios = require("axios");
const {
  getEvolutionApiConfig,
  getEvolutionRequestHeaders,
} = require("../evolutionConfig.service");

const { baseUrl: EVOLUTION_API_URL, usingDefaultApiKey } = getEvolutionApiConfig();
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_AUDIO_MODEL = process.env.GROQ_AUDIO_MODEL || "whisper-large-v3";
const AUDIO_DOWNLOAD_ERROR = "[Error al descargar el audio]";
const AUDIO_TRANSCRIPTION_FAILED = "[Audio recibido, pero fallo la transcripcion]";
const AUDIO_TRANSCRIPTION_NOT_CONFIGURED =
  "[Audio recibido, pero la transcripcion por IA no esta configurada]";

const getMediaBase64 = async (instanceName, messageId) => {
  try {
    if (usingDefaultApiKey) {
      console.warn(
        "Audio transcription is using the default Evolution API key fallback. Check EVOLUTION_API_KEY in production."
      );
    }

    const response = await axios.post(
      `${EVOLUTION_API_URL.replace(/\/$/, "")}/chat/getBase64FromMediaMessage/${instanceName}`,
      {
        message: {
          key: {
            id: messageId,
          },
        },
      },
      {
        headers: getEvolutionRequestHeaders(),
      }
    );

    return response.data.base64;
  } catch (error) {
    console.error(
      "Error obteniendo base64 del audio desde Evolution API:",
      error?.response?.data || error.message
    );
    return null;
  }
};

const normalizeAudioBase64 = (value) => {
  const raw = String(value || "").trim();
  return raw.startsWith("data:") ? raw.replace(/^data:.*?;base64,/, "") : raw;
};

const transcribeAudio = async (base64Data) => {
  if (!GROQ_API_KEY) {
    console.log(
      "No hay GROQ_API_KEY configurada para transcribir audios. Agregala en el archivo .env"
    );
    return AUDIO_TRANSCRIPTION_NOT_CONFIGURED;
  }

  const normalizedBase64 = normalizeAudioBase64(base64Data);
  if (!normalizedBase64) {
    return AUDIO_DOWNLOAD_ERROR;
  }

  try {
    const audioBuffer = Buffer.from(normalizedBase64, "base64");
    const form = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: "audio/ogg" });

    form.append("file", audioBlob, "audio.ogg");
    form.append("model", GROQ_AUDIO_MODEL);
    form.append("temperature", "0");
    form.append("response_format", "verbose_json");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: form,
    });

    if (!response.ok) {
      const errorPayload = await response.text();
      throw new Error(errorPayload || `Groq audio error ${response.status}`);
    }

    const transcription = await response.json();
    const text = String(transcription?.text || "").trim();
    return text || AUDIO_TRANSCRIPTION_FAILED;
  } catch (error) {
    console.error("Error transcribiendo audio con Groq:", error.message);
    return AUDIO_TRANSCRIPTION_FAILED;
  }
};

const processAudioMessage = async (instanceName, messageId) => {
  const base64 = await getMediaBase64(instanceName, messageId);
  if (!base64) {
    return AUDIO_DOWNLOAD_ERROR;
  }

  const transcript = await transcribeAudio(base64);
  console.log(`Audio transcrito (${messageId}):`, transcript);
  return transcript;
};

module.exports = {
  processAudioMessage,
  transcribeAudio,
  AUDIO_DOWNLOAD_ERROR,
  AUDIO_TRANSCRIPTION_FAILED,
  AUDIO_TRANSCRIPTION_NOT_CONFIGURED,
};
