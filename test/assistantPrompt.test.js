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
