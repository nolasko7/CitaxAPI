const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractIncomingMessages,
  hasProcessableText,
  normalizeIncomingMessage,
} = require("../src/services/evolution.service");

test("normalizeIncomingMessage handles plain text messages", () => {
  const normalized = normalizeIncomingMessage(
    "citax-empresa-2-whatsapp",
    {
      key: {
        id: "msg-1",
        remoteJid: "5492657000000@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        conversation: "Hola, quiero un turno",
      },
      pushName: "Valentin",
      messageTimestamp: 1710000000,
    },
    { event: "messages.upsert" }
  );

  assert.equal(normalized.text, "Hola, quiero un turno");
  assert.equal(normalized.isAudio, false);
  assert.equal(normalized.messageType, "conversation");
  assert.equal(normalized.phoneNumber, "5492657000000");
});

test("normalizeIncomingMessage detects direct audio messages", () => {
  const normalized = normalizeIncomingMessage(
    "citax-empresa-2-whatsapp",
    {
      key: {
        id: "audio-1",
        remoteJid: "5492657000000@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          seconds: 4,
          ptt: true,
        },
      },
    },
    { event: "messages.upsert" }
  );

  assert.equal(normalized.messageType, "audioMessage");
  assert.equal(normalized.rawType, "audioMessage");
  assert.equal(normalized.isAudio, true);
  assert.equal(normalized.text, "");
});

test("normalizeIncomingMessage detects wrapped ephemeral audio messages", () => {
  const normalized = normalizeIncomingMessage(
    "citax-empresa-2-whatsapp",
    {
      key: {
        id: "audio-2",
        remoteJid: "5492657000000@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        ephemeralMessage: {
          message: {
            audioMessage: {
              mimetype: "audio/ogg",
              seconds: 8,
            },
          },
        },
      },
    },
    { event: "messages.upsert" }
  );

  assert.equal(normalized.messageType, "audioMessage");
  assert.equal(normalized.isAudio, true);
});

test("extractIncomingMessages supports payload.data.messages", () => {
  const messages = extractIncomingMessages({
    event: "messages.upsert",
    data: {
      messages: [
        {
          key: { id: "msg-2" },
          message: { conversation: "Hola" },
        },
      ],
    },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].key.id, "msg-2");
});

test("extractIncomingMessages supports payload.data as single message", () => {
  const messages = extractIncomingMessages({
    event: "messages.upsert",
    data: {
      key: { id: "msg-3" },
      message: { conversation: "Necesito ayuda" },
    },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].key.id, "msg-3");
});

test("hasProcessableText rejects empty and transcription placeholders", () => {
  assert.equal(hasProcessableText(""), false);
  assert.equal(hasProcessableText("   "), false);
  assert.equal(hasProcessableText("[Error al descargar el audio]"), false);
  assert.equal(
    hasProcessableText("[Audio recibido, pero falló la transcripción]"),
    false
  );
  assert.equal(hasProcessableText("Necesito cancelar mi turno"), true);
});
