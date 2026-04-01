const test = require("node:test");
const assert = require("node:assert/strict");
const { AIMessage, HumanMessage } = require("@langchain/core/messages");

const loadServiceWithEnv = (overrides = {}) => {
  const envKeys = [
    "GOOGLE_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_MAX_RETRIES",
    "WHATSAPP_AI_ENABLED",
  ];
  const previous = {};

  for (const key of envKeys) {
    previous[key] = process.env[key];
  }

  Object.assign(process.env, {
    WHATSAPP_AI_ENABLED: "true",
    ...overrides,
  });

  const modulePath = require.resolve("../src/services/ai/geminiService");
  delete require.cache[modulePath];
  const service = require("../src/services/ai/geminiService");

  const restore = () => {
    for (const key of envKeys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    delete require.cache[modulePath];
  };

  return { service, restore };
};

test("getGeminiConfig returns the configured Gemini model and key", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
    GEMINI_MODEL: "gemini-3-flash-preview",
  });

  try {
    const config = service.__testables.getGeminiConfig();
    assert.equal(config.name, "google-genai");
    assert.equal(config.model, "gemini-3-flash-preview");
    assert.equal(config.apiKey, "google-test-key");
    assert.equal(config.label, "google-gemini-3-flash-preview");
  } finally {
    restore();
  }
});

test("isAssistantConfigured only enables the bot when GOOGLE_API_KEY exists", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "",
  });

  try {
    assert.equal(service.isAssistantConfigured(), false);
  } finally {
    restore();
  }
});

test("sanitizeAssistantReply removes raw TOOLCALL protocol markers", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const sanitized = service.__testables.sanitizeAssistantReply(
      'TOOLCALL>[{"name":"find_available_slots","arguments":{"startDate":"2026-03-31"}}]<CALL>'
    );
    assert.equal(sanitized, "");
  } finally {
    restore();
  }
});

test("parseInlineToolCallsFromContent parses inline TOOLCALL markup", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const parsed = service.__testables.parseInlineToolCallsFromContent(
      'TOOLCALL>[{"name":"find_available_slots","arguments":{"startDate":"2026-03-31","endDate":"2026-03-31","limit":40,"professionalName":"Carlos"}}]<CALL>'
    );

    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, "find_available_slots");
    assert.deepEqual(parsed.toolCalls[0].args, {
      startDate: "2026-03-31",
      endDate: "2026-03-31",
      limit: 40,
      professionalName: "Carlos",
    });
    assert.equal(parsed.content, "");
  } finally {
    restore();
  }
});

test("extractAssistantReplyFromMessages returns sanitized final assistant text", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const extracted = service.__testables.extractAssistantReplyFromMessages([
      new AIMessage({
        content:
          'TOOLCALL>[{"name":"find_available_slots","arguments":{"startDate":"2026-03-31"}}]<CALL>',
        tool_calls: [
          {
            name: "find_available_slots",
            args: { startDate: "2026-03-31" },
          },
        ],
      }),
      new AIMessage({
        content: "Turno confirmado para hoy martes 31 a las 13:00.",
      }),
    ]);

    assert.equal(extracted.reply, "Turno confirmado para hoy martes 31 a las 13:00.");
  } finally {
    restore();
  }
});

test("stringifyMessageContent preserves plain user text", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const text = service.__testables.stringifyMessageContent(
      new HumanMessage("Hola").content
    );
    assert.equal(text, "Hola");
  } finally {
    restore();
  }
});

test("getConfiguredWelcomeMessage renders {nombre_cliente} and falls back to default", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.getConfiguredWelcomeMessage({
        welcomeMessage: "Hola {nombre_cliente}, como estas, queres reservar un turno?",
      }, "Valentin"),
      "Hola Valentin, como estas, queres reservar un turno?",
    );
    assert.equal(
      service.__testables.getConfiguredWelcomeMessage({
        welcomeMessage: "Hola {nombre_cliente}, como estas, queres reservar un turno?",
      }),
      "Hola, como estas, queres reservar un turno?",
    );
    assert.equal(
      service.__testables.getConfiguredWelcomeMessage({
        welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
      }),
      "Buenas, soy Sergio. Decime si queres reservar.",
    );
    assert.equal(
      service.__testables.getConfiguredWelcomeMessage({}),
      "Hola, como estas amigaso, queres reservar un turno para hoy?",
    );
  } finally {
    restore();
  }
});

test("buildFriendlyGreetingPrefix uses configured saludo on first conversation", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.buildFriendlyGreetingPrefix({
        ownPhrases: { saludos: "amigaso" },
      }),
      "Hola, amigaso"
    );
    assert.equal(
      service.__testables.buildFriendlyGreetingPrefix({
        ownPhrases: { saludos: "Buenas, como estas" },
      }),
      "Buenas, como estas"
    );
  } finally {
    restore();
  }
});

test("shouldUseConfiguredWelcomeReply only triggers for initial pure greetings", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.shouldUseConfiguredWelcomeReply({
        history: [],
        incomingText: "Hola, como estas",
        welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
      }),
      true,
    );
    assert.equal(
      service.__testables.shouldUseConfiguredWelcomeReply({
        history: [new AIMessage({ content: "Mensaje previo" })],
        incomingText: "Hola",
        welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
      }),
      false,
    );
    assert.equal(
      service.__testables.shouldUseConfiguredWelcomeReply({
        history: [],
        incomingText: "Hola, quiero un turno",
        welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
      }),
      false,
    );
    assert.equal(
      service.__testables.shouldUseConfiguredWelcomeReply({
        hasPriorReply: true,
        incomingText: "Hola",
        welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
      }),
      false,
    );
  } finally {
    restore();
  }
});

test("isClosingOnlyMessage detects pure closing replies", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(service.__testables.isClosingOnlyMessage("Gracias, hola"), true);
    assert.equal(service.__testables.isClosingOnlyMessage("joya sergio nos vemos"), true);
    assert.equal(service.__testables.isClosingOnlyMessage("Hola, necesito otro turno"), false);
  } finally {
    restore();
  }
});

test("sanitizeAssistantOpening removes repeated laughter openings when user did not laugh", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.sanitizeAssistantOpening({
        reply: "Jaja, tengo turnos para el lunes.",
        incomingText: "que turnos tenes para el lunes?",
      }),
      "tengo turnos para el lunes."
    );
    assert.equal(
      service.__testables.sanitizeAssistantOpening({
        reply: "Jaja, tengo turnos para el lunes.",
        incomingText: "jaja, que turnos tenes para el lunes?",
      }),
      "Jaja, tengo turnos para el lunes."
    );
  } finally {
    restore();
  }
});

test("ensureFriendlyFirstReply prefixes first answer with configured saludo", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.ensureFriendlyFirstReply({
        reply: "tengo turnos para el lunes a las 10 y 11.",
        companyContext: { ownPhrases: { saludos: "amigaso" } },
        shouldPrefixGreeting: true,
      }),
      "Hola, amigaso. tengo turnos para el lunes a las 10 y 11."
    );
  } finally {
    restore();
  }
});

test("shouldSilenceClosingReply only silences replies after an appointment confirmation", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const shouldSilence = service.__testables.shouldSilenceClosingReply({
      history: [
        new AIMessage({
          content: "Listo, tu turno quedo confirmado para hoy lunes 31 a las 13:00.",
        }),
      ],
      incomingText: "Gracias",
    });

    const shouldKeepTalking = service.__testables.shouldSilenceClosingReply({
      history: [
        new AIMessage({
          content: "Hola, como estas amigaso, queres reservar un turno para hoy?",
        }),
      ],
      incomingText: "Hola",
    });
    const shouldSilenceWithoutHistory = service.__testables.shouldSilenceClosingReply({
      lastAssistantReply:
        "Listo, tu turno quedo confirmado para hoy lunes 31 a las 13:00. Cualquier consulta, no dudes en llamarme",
      incomingText: "Gracias, nos vemos",
    });

    assert.equal(shouldSilence, true);
    assert.equal(shouldKeepTalking, false);
    assert.equal(shouldSilenceWithoutHistory, true);
  } finally {
    restore();
  }
});

test("isAvailabilityLookupIntent detects turno and horario requests", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(
      service.__testables.isAvailabilityLookupIntent("que turnos tenes para el lunes?"),
      true,
    );
    assert.equal(
      service.__testables.isAvailabilityLookupIntent("tenes horarios para maÃ±ana?"),
      true,
    );
    assert.equal(
      service.__testables.isAvailabilityLookupIntent("gracias, nos vemos"),
      false,
    );
  } finally {
    restore();
  }
});

test("buildTemporalReferenceText includes exact today and tomorrow references", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const realtimeContext = service.__testables.buildRealtimeTemporalContext(
      "America/Argentina/Buenos_Aires"
    );
    const temporalRef = service.__testables.buildTemporalReferenceText(realtimeContext);
    const normalizedTemporalRef = temporalRef
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    assert.match(normalizedTemporalRef, /Hoy exacto:/);
    assert.match(normalizedTemporalRef, /Ma.*ana exacto:/);
    assert.match(
      normalizedTemporalRef,
      new RegExp(realtimeContext.localDate.replace(/[-/]/g, "[-/]"))
    );
  } finally {
    restore();
  }
});

test("buildFinalReplyRecoveryMessages appends a final synthesis instruction", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const messages = service.__testables.buildFinalReplyRecoveryMessages([
      new AIMessage({ content: "" }),
    ]);

    assert.equal(messages.length, 2);
    assert.equal(messages[1]._getType(), "human");
    assert.match(String(messages[1].content || ""), /responde ahora al cliente/i);
  } finally {
    restore();
  }
});

test("sanitizeNonReplyOutput removes literal no-response markers", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    assert.equal(service.__testables.sanitizeNonReplyOutput("No response"), "");
    assert.equal(service.__testables.sanitizeNonReplyOutput("Sin respuesta"), "");
    assert.equal(
      service.__testables.sanitizeNonReplyOutput("Listo, tu turno quedo confirmado."),
      "Listo, tu turno quedo confirmado."
    );
  } finally {
    restore();
  }
});

test("ensureAppointmentConfirmationClosing appends the required closing phrase once", () => {
  const { service, restore } = loadServiceWithEnv({
    GOOGLE_API_KEY: "google-test-key",
  });

  try {
    const baseReply = "Listo, tu turno quedo confirmado para hoy lunes 31 a las 13:00.";
    const completed = service.__testables.ensureAppointmentConfirmationClosing(baseReply);
    const preserved = service.__testables.ensureAppointmentConfirmationClosing(
      "Listo, tu turno quedo confirmado para hoy lunes 31 a las 13:00. Cualquier consulta, no dudes en llamarme"
    );

    assert.match(completed, /Cualquier consulta, no dudes en llamarme$/);
    assert.equal(
      preserved,
      "Listo, tu turno quedo confirmado para hoy lunes 31 a las 13:00. Cualquier consulta, no dudes en llamarme"
    );
  } finally {
    restore();
  }
});


