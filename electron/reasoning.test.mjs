import assert from "node:assert/strict";
import test from "node:test";
import { applyContextPolicy, applyReasoningPolicy, contextHash, validateActivityReasoning } from "./reasoning.mjs";

const valid = {
  classification: "related",
  trajectory: "research",
  confidence: "high",
  recommendIntervention: false,
  message: "This looks connected to your current priority.",
  reason: "The browser visit is surrounded by implementation work.",
};

test("validates a complete, shallow reasoning result", () => {
  assert.deepEqual(validateActivityReasoning(valid), { ...valid, confidenceBand: "high", confidence: 90 });
});

test("rejects unknown fields and unsupported confidence values", () => {
  assert.throws(() => validateActivityReasoning({ ...valid, extra: true }));
  assert.throws(() => validateActivityReasoning({ ...valid, confidence: "certain" }));
});

test("rejects overlong generated copy", () => {
  assert.throws(() => validateActivityReasoning({ ...valid, message: "x".repeat(181) }));
});

test("context hashes are stable and change with material context", () => {
  assert.equal(contextHash({ task: "A", app: "Code" }), contextHash({ task: "A", app: "Code" }));
  assert.notEqual(contextHash({ task: "A", app: "Code" }), contextHash({ task: "A", app: "Browser" }));
});

test("policy converts low-confidence and contradictory advice into a safe abstention", () => {
  const normalized = validateActivityReasoning(valid);
  assert.deepEqual(
    applyReasoningPolicy({ ...normalized, confidenceBand: "low", confidence: 40, recommendIntervention: true, reason: "" }),
    {
      ...normalized,
      classification: "unknown",
      confidenceBand: "low",
      confidence: 40,
      recommendIntervention: false,
      reason: "The local model did not find enough evidence to explain this classification.",
    },
  );
  assert.equal(applyReasoningPolicy({ ...normalized, recommendIntervention: true }).recommendIntervention, false);
});

test("maps high-confidence distraction to the intervention threshold", () => {
  const distraction = validateActivityReasoning({
    ...valid,
    classification: "distraction",
    trajectory: "distraction",
    confidence: "high",
    recommendIntervention: true,
  });
  assert.equal(applyReasoningPolicy(distraction).confidence, 90);
  assert.equal(applyReasoningPolicy(distraction).recommendIntervention, true);
});

test("generic browser evidence abstains without a learned relationship", () => {
  const distraction = applyReasoningPolicy(validateActivityReasoning({
    ...valid,
    classification: "distraction",
    trajectory: "distraction",
    confidence: "high",
    recommendIntervention: true,
  }));
  assert.deepEqual(
    applyContextPolicy(distraction, { current: { application: "firefox-esr" }, learnedRelationship: null }),
    {
      ...distraction,
      classification: "unknown",
      trajectory: "unknown",
      confidenceBand: "low",
      confidence: 40,
      recommendIntervention: false,
      reason: "A browser identifier alone does not reveal whether the activity is task-related.",
    },
  );
});
