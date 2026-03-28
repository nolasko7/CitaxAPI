const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
const AUDIO_TRANSCRIPTION_MODEL = process.env.AUDIO_TRANSCRIPTION_MODEL || "gemini-2.0-flash";
const AUDIO_DOWNLOAD_ERROR = "[Error al descargar el audio]";
const AUDIO_TRANSCRIPTION_FAILED = "[Audio recibido, pero falló la transcripción]";
const AUDIO_TRANSCRIPTION_NOT_CONFIGURED = "[Audio recibido, pero la transcripción por IA no está configurada]";

/**
 * Obtiene el base64 de un mensaje multimedia desde Evolution API
 */
const getMediaBase64 = async (instanceName, messageId) => {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${instanceName}`,
      {
        message: {
          key: {
            id: messageId
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        }
      }
    );
    
    return response.data.base64;
  } catch (error) {
    console.error('❌ Error obteniendo base64 del audio desde Evolution API:', error?.response?.data || error.message);
    return null;
  }
};

/**
 * Transcribe un audio en base64 usando Google Gemini
 */
const transcribeAudio = async (base64Data) => {
  if (!GOOGLE_API_KEY) {
    console.log("⚠️ No hay GOOGLE_API_KEY configurada para transcribir audios. Por favor, agregala en el archivo .env");
    return AUDIO_TRANSCRIPTION_NOT_CONFIGURED;
  }

  if (!String(base64Data || "").trim()) {
    return AUDIO_DOWNLOAD_ERROR;
  }

  try {
    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    // Usamos un modelo rápido con soporte nativo de audio y configurable por entorno.
    const model = genAI.getGenerativeModel({ model: AUDIO_TRANSCRIPTION_MODEL }); 
    
    const result = await model.generateContent([
      "Desgraba el siguiente audio con total precisión. No agregues comillas, comentarios ni aclaraciones. Solo quiero el texto de lo que se dijo:",
      {
        inlineData: {
          mimeType: "audio/ogg", 
          data: base64Data
        }
      }
    ]);

    return result.response.text().trim();
  } catch (error) {
    console.error('❌ Error transcribiendo audio con Gemini:', error.message);
    return AUDIO_TRANSCRIPTION_FAILED;
  }
};

/**
 * Procesa un mensaje de audio entrante
 */
const processAudioMessage = async (instanceName, messageId) => {
  const base64 = await getMediaBase64(instanceName, messageId);
  if (!base64) {
    return AUDIO_DOWNLOAD_ERROR;
  }

  const transcript = await transcribeAudio(base64);
  console.log(`🎙️ Audio transcrito (${messageId}):`, transcript);
  return transcript;
};

module.exports = {
  processAudioMessage,
  transcribeAudio,
  AUDIO_DOWNLOAD_ERROR,
  AUDIO_TRANSCRIPTION_FAILED,
  AUDIO_TRANSCRIPTION_NOT_CONFIGURED
};
