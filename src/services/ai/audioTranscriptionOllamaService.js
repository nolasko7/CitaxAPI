const axios = require("axios");

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434/api";
const AUDIO_TRANSCRIPTION_MODEL =
  process.env.AUDIO_TRANSCRIPTION_MODEL || process.env.OLLAMA_MODEL || "llama3.2";
const AUDIO_DOWNLOAD_ERROR = "[Error al descargar el audio]";
const AUDIO_TRANSCRIPTION_FAILED = "[Audio recibido, pero fallo la transcripcion]";
const AUDIO_TRANSCRIPTION_NOT_CONFIGURED =
  "[Audio recibido, pero la transcripcion por IA no esta configurada]";

const resolveOllamaOpenAiBaseUrl = (value) => {
  const normalized = String(value || "").trim().replace(/\/$/, "");

  if (!normalized) {
    return "http://localhost:11434/v1";
  }

  if (normalized.endsWith("/v1")) {
    return normalized;
  }

  if (normalized.endsWith("/api")) {
    return `${normalized.slice(0, -4)}/v1`;
  }

  return `${normalized}/v1`;
};

const OLLAMA_OPENAI_BASE_URL = resolveOllamaOpenAiBaseUrl(OLLAMA_API_URL);

const buildOllamaHeaders = () => {
  const headers = {
    "Content-Type": "application/json",
  };

  if (OLLAMA_API_KEY) {
    headers.Authorization = `Bearer ${OLLAMA_API_KEY}`;
  }

  return headers;
};

const normalizeAudioBase64 = (value) => {
  const raw = String(value || "").trim();
  const hasDataUriPrefix = raw.startsWith("data:");
  const normalized = hasDataUriPrefix ? raw.replace(/^data:.*?;base64,/, "") : raw;

  return {
    normalized,
    hasDataUriPrefix,
  };
};

const getMediaBase64 = async (instanceName, messageId) => {
  try {
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
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
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

const transcribeAudio = async (base64Data) => {
  if (!AUDIO_TRANSCRIPTION_MODEL) {
    console.log(
      "No hay OLLAMA_MODEL configurado para transcribir audios. Agregalo en el archivo .env"
    );
    return AUDIO_TRANSCRIPTION_NOT_CONFIGURED;
  }

  if (!String(base64Data || "").trim()) {
    return AUDIO_DOWNLOAD_ERROR;
  }

  try {
    const normalizedAudio = normalizeAudioBase64(base64Data);
    const payload = {
      model: AUDIO_TRANSCRIPTION_MODEL,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Sos un transcriptor de audio preciso. Devolve solo la transcripcion literal del audio, sin comillas ni comentarios.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribi este audio en espanol. Devolve unicamente el texto dicho.",
            },
            {
              type: "input_audio",
              input_audio: {
                data: normalizedAudio.normalized,
                format: "ogg",
              },
            },
          ],
        },
      ],
    };

    console.log("Ollama audio debug:", {
      url: `${OLLAMA_OPENAI_BASE_URL}/chat/completions`,
      model: AUDIO_TRANSCRIPTION_MODEL,
      hasApiKey: Boolean(OLLAMA_API_KEY),
      audioBase64Length: normalizedAudio.normalized.length,
      hadDataUriPrefix: normalizedAudio.hasDataUriPrefix,
      audioBase64Preview: normalizedAudio.normalized.slice(0, 32),
      messageShape: payload.messages.map((message) => ({
        role: message.role,
        contentType: Array.isArray(message.content) ? "array" : typeof message.content,
        parts: Array.isArray(message.content)
          ? message.content.map((part) => part.type)
          : [],
      })),
    });

    const response = await axios.post(
      `${OLLAMA_OPENAI_BASE_URL}/chat/completions`,
      payload,
      {
        headers: buildOllamaHeaders(),
        timeout: 120000,
      }
    );

    const transcript = String(response.data?.choices?.[0]?.message?.content || "").trim();
    return transcript || AUDIO_TRANSCRIPTION_FAILED;
  } catch (error) {
    console.error(
      "Error transcribiendo audio con Ollama:",
      error?.response?.data || error.message
    );
    console.error("Ollama audio error debug:", {
      status: error?.response?.status || null,
      url: `${OLLAMA_OPENAI_BASE_URL}/chat/completions`,
      model: AUDIO_TRANSCRIPTION_MODEL,
    });
    if (String(error?.response?.data?.error?.message || "").toLowerCase().includes("invalid message format")) {
      console.error(
        "Ollama audio note: el endpoint /v1/chat/completions parece rechazar input_audio para este modelo o API."
      );
    }
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
