const test = require("node:test");
const assert = require("node:assert/strict");
const { AIMessage, HumanMessage, ToolMessage } = require("@langchain/core/messages");

const loadServiceWithEnv = (overrides = {}) => {
  const envKeys = [
    "LLM_PRIMARY_PROVIDER",
    "LLM_PRIMARY_API_KEY",
    "LLM_PRIMARY_BASE_URL",
    "GROQ_API_KEY",
    "LLM_PRIMARY_MODEL",
    "GROQ_MODEL",
    "LLM_PRIMARY_LABEL",
    "LLM_FALLBACK_PROVIDER",
    "LLM_FALLBACK_API_KEY",
    "LLM_FALLBACK_BASE_URL",
    "OPENROUTER_API_KEY",
    "LLM_FALLBACK_MODEL",
    "LLM_FALLBACK_LABEL",
    "OPENROUTER_MODEL",
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

test("getConfiguredProviders returns Groq primary and OpenRouter fallback", () => {
  const { service, restore } = loadServiceWithEnv({
    LLM_PRIMARY_PROVIDER: "groq",
    LLM_PRIMARY_MODEL: "llama-3.3-70b-versatile",
    GROQ_API_KEY: "groq-test-key",
    GROQ_MODEL: "llama-3.3-70b-versatile",
    LLM_FALLBACK_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-test-key",
    LLM_FALLBACK_MODEL: "openrouter/free",
  });

  try {
    const providers = service.__testables.getConfiguredProviders();
    assert.equal(providers.length, 2);
    assert.equal(providers[0].name, "groq");
    assert.equal(providers[0].model, "llama-3.3-70b-versatile");
    assert.equal(providers[1].name, "openrouter");
    assert.equal(providers[1].model, "openrouter/free");
  } finally {
    restore();
  }
});

test("getConfiguredProviders supports OpenRouter primary and Groq fallback", () => {
  const { service, restore } = loadServiceWithEnv({
    LLM_PRIMARY_PROVIDER: "openrouter",
    LLM_PRIMARY_MODEL: "qwen/qwen3.6-plus-preview:free",
    LLM_PRIMARY_LABEL: "openrouter-qwen-primary",
    OPENROUTER_API_KEY: "openrouter-test-key",
    LLM_FALLBACK_PROVIDER: "groq",
    LLM_FALLBACK_MODEL: "llama-3.3-70b-versatile",
    LLM_FALLBACK_LABEL: "groq-fallback",
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    const providers = service.__testables.getConfiguredProviders();
    assert.equal(providers.length, 2);
    assert.equal(providers[0].name, "openrouter");
    assert.equal(providers[0].model, "qwen/qwen3.6-plus-preview:free");
    assert.equal(providers[0].label, "openrouter-qwen-primary");
    assert.equal(providers[1].name, "groq");
    assert.equal(providers[1].model, "llama-3.3-70b-versatile");
    assert.equal(providers[1].label, "groq-fallback");
  } finally {
    restore();
  }
});

test("getToolDefinitions only returns definitions for requested tools", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    const definitions = service.__testables.getToolDefinitions([
      { name: "find_available_slots" },
      { name: "create_appointment" },
    ]);

    assert.deepEqual(
      definitions.map((definition) => definition.function.name),
      ["find_available_slots", "create_appointment"]
    );
  } finally {
    restore();
  }
});

test("toOpenAIChatMessage converts assistant tool calls and tool results", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    const assistantMessage = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_1",
          name: "find_available_slots",
          args: { startDate: "2026-03-31" },
        },
      ],
    });
    const toolMessage = new ToolMessage({
      content: "{\"slots\":[]}",
      tool_call_id: "call_1",
    });

    const assistantPayload =
      service.__testables.toOpenAIChatMessage(assistantMessage);
    const toolPayload = service.__testables.toOpenAIChatMessage(toolMessage);

    assert.equal(assistantPayload.role, "assistant");
    assert.equal(assistantPayload.tool_calls[0].function.name, "find_available_slots");
    assert.equal(toolPayload.role, "tool");
    assert.equal(toolPayload.tool_call_id, "call_1");
  } finally {
    restore();
  }
});

test("toLangChainAIMessage parses tool calls from OpenAI-compatible response", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    const message = service.__testables.toLangChainAIMessage({
      provider: "groq-llama-3.3-70b",
      model: "llama-3.3-70b-versatile",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "get_appointments_by_day",
                  arguments: "{\"date\":\"2026-03-31\"}",
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
    });

    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].name, "get_appointments_by_day");
    assert.deepEqual(message.tool_calls[0].args, { date: "2026-03-31" });
    assert.equal(message.usage_metadata.total_tokens, 14);
  } finally {
    restore();
  }
});

test("toLangChainAIMessage parses inline TOOLCALL markup into tool calls", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    const message = service.__testables.toLangChainAIMessage({
      provider: "groq-llama-3.1-8b",
      model: "llama-3.1-8b-instant",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content:
              'TOOLCALL>[{"name":"find_available_slots","arguments":{"startDate":"2026-03-31","endDate":"2026-03-31","limit":40,"professionalName":"Carlos"}}]<CALL>',
          },
        },
      ],
    });

    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].name, "find_available_slots");
    assert.deepEqual(message.tool_calls[0].args, {
      startDate: "2026-03-31",
      endDate: "2026-03-31",
      limit: 40,
      professionalName: "Carlos",
    });
    assert.equal(message.content, "");
  } finally {
    restore();
  }
});

test("sanitizeAssistantReply removes raw TOOLCALL protocol markers", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
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

test("extractAssistantReplyFromMessages returns sanitized final assistant text", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
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
    GROQ_API_KEY: "groq-test-key",
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
    GROQ_API_KEY: "groq-test-key",
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

test("shouldUseConfiguredWelcomeReply only triggers for initial pure greetings", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
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
  } finally {
    restore();
  }
});

test("isClosingOnlyMessage detects pure closing replies", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
  });

  try {
    assert.equal(service.__testables.isClosingOnlyMessage("Gracias, hola"), true);
    assert.equal(service.__testables.isClosingOnlyMessage("joya sergio nos vemos"), true);
    assert.equal(service.__testables.isClosingOnlyMessage("Hola, necesito otro turno"), false);
  } finally {
    restore();
  }
});

test("shouldSilenceClosingReply only silences replies after an appointment confirmation", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
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

    assert.equal(shouldSilence, true);
    assert.equal(shouldKeepTalking, false);
  } finally {
    restore();
  }
});

test("sanitizeNonReplyOutput removes literal no-response markers", () => {
  const { service, restore } = loadServiceWithEnv({
    GROQ_API_KEY: "groq-test-key",
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
    GROQ_API_KEY: "groq-test-key",
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
