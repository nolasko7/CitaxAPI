const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAssistantPrompt,
  DEFAULT_WELCOME_MESSAGE,
} = require("../src/services/ai/assistantPrompt");

test("buildAssistantPrompt injects the configured welcome message", () => {
  const prompt = buildAssistantPrompt({
    companyName: "Sergio Barber",
    welcomeMessage: "Buenas, soy Sergio. Decime si queres reservar.",
  });

  assert.match(
    prompt,
    /Buenas, soy Sergio\. Decime si queres reservar\./,
  );
});

test("buildAssistantPrompt falls back to the default welcome message", () => {
  const prompt = buildAssistantPrompt({
    companyName: "Sergio Barber",
  });

  assert.match(prompt, new RegExp(DEFAULT_WELCOME_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildAssistantPrompt includes business own phrases as style guidance", () => {
  const prompt = buildAssistantPrompt({
    companyName: "Sergio Barber",
    ownPhrases: {
      general: "Deci 'corte' en vez de servicio.",
      saludos: "Usa 'amigaso' en saludos.",
      confirmaciones: "Cuando confirmes, deci 'de una'.",
      cierres: "Para cerrar, usa 'abrazo grande'.",
    },
  });

  assert.match(prompt, /Palabras y frases propias del negocio:/);
  assert.match(prompt, /Generales: Deci 'corte' en vez de servicio\./);
  assert.match(prompt, /Usa 'amigaso' en saludos/);
  assert.match(prompt, /Para confirmaciones: Cuando confirmes, deci 'de una'\./);
  assert.match(prompt, /Para cierres: Para cerrar, usa 'abrazo grande'\./);
});

test("buildAssistantPrompt documents how to treat manual confirmed cancellations", () => {
  const prompt = buildAssistantPrompt({
    companyName: "Sergio Barber",
  });

  assert.match(prompt, /manual_confirmed_cancellation/);
  assert.match(prompt, /No intentes reconfirmarlo ni recrearlo/);
});
