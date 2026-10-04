import { createHash } from "node:crypto";

export const activityReasoningSchema = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["related", "neutral", "distraction", "unknown"] },
    trajectory: { type: "string", enum: ["deep_work", "implementation", "research", "debugging", "communication", "planning", "task_switching", "distraction", "unknown"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    recommendIntervention: { type: "boolean" },
    message: { type: "string", maxLength: 180 },
    reason: { type: "string", maxLength: 240 },
  },
  required: ["classification", "trajectory", "confidence", "recommendIntervention", "message", "reason"],
  additionalProperties: false,
};

const classifications = new Set(activityReasoningSchema.properties.classification.enum);
const trajectories = new Set(activityReasoningSchema.properties.trajectory.enum);
const confidenceScores = { low: 40, medium: 70, high: 90 };
const requiredKeys = Object.keys(activityReasoningSchema.properties);

export function validateActivityReasoning(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Reasoning result must be an object");
  const keys = Object.keys(payload);
  if (keys.some((key) => !requiredKeys.includes(key)) || requiredKeys.some((key) => !keys.includes(key))) {
    throw new Error("Reasoning result has an invalid shape");
  }
  if (!classifications.has(payload.classification)) throw new Error("Invalid activity classification");
  if (!trajectories.has(payload.trajectory)) throw new Error("Invalid activity trajectory");
  if (!(payload.confidence in confidenceScores)) throw new Error("Invalid confidence band");
  if (typeof payload.recommendIntervention !== "boolean") throw new Error("Invalid intervention recommendation");
  if (typeof payload.message !== "string" || payload.message.length > 180) throw new Error("Invalid intervention message");
  if (typeof payload.reason !== "string" || payload.reason.length > 240) throw new Error("Invalid reasoning explanation");
  return {
    classification: payload.classification,
    trajectory: payload.trajectory,
    confidenceBand: payload.confidence,
    confidence: confidenceScores[payload.confidence],
    recommendIntervention: payload.recommendIntervention,
    message: payload.message.trim(),
    reason: payload.reason.trim(),
  };
}

export function applyReasoningPolicy(reasoning) {
  const result = { ...reasoning };
  if (result.confidence < 65) result.classification = "unknown";
  if (result.classification !== "distraction" || result.confidence < 80) result.recommendIntervention = false;
  if (!result.reason) result.reason = "The local model did not find enough evidence to explain this classification.";
  return result;
}

export function applyContextPolicy(reasoning, context) {
  const result = { ...reasoning };
  const application = String(context?.current?.application ?? "").toLowerCase();
  const isGenericBrowser = ["firefox", "chrome", "chromium", "brave", "edge"].some((name) => application.includes(name));
  if (isGenericBrowser && !context?.learnedRelationship) {
    result.classification = "unknown";
    result.trajectory = "unknown";
    result.confidenceBand = "low";
    result.confidence = 40;
    result.recommendIntervention = false;
    result.reason = "A browser identifier alone does not reveal whether the activity is task-related.";
  }
  if (result.classification === "distraction") result.trajectory = "distraction";
  return result;
}

export function contextHash(context) {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export function reasoningPrompt(context, validationError = "") {
  return `You are the private, local activity reasoner for Raj's focus assistant.
Decide whether the current application activity supports the active task using ONLY the supplied context.
Application names are weak evidence: a browser, chat app, or video app may be legitimate research or communication.
Never invent a window title, URL, website, document, or action. Return unknown when the evidence is insufficient.
The program has already calculated all durations. Do not recalculate them.
Use calm, non-judgmental language. Recommend an intervention only for strong evidence of distraction.
Choose confidence from low, medium, or high. Use low when application-only evidence is insufficient, medium when a sequence suggests a result, and high only for a direct learned relationship or repeated clear evidence. Only high-confidence distraction may recommend an intervention.
Judge the CURRENT application first; recent sessions are supporting context only. Do not call the current application related merely because an earlier application was related.
Use related only when the supplied task, learned relationship, or recognizable application purpose gives a plausible work connection you can state. A generic browser with no learned relationship is usually unknown.
A clearly named game or game launcher used during a non-gaming work task is distraction with high confidence and should recommend an intervention.
Return exactly one JSON object with exactly these keys and types:
- classification: one of related, neutral, distraction, unknown
- trajectory: one of deep_work, implementation, research, debugging, communication, planning, task_switching, distraction, unknown
- confidence: one of low, medium, high
- recommendIntervention: boolean true or false
- message: a short string
- reason: a short string

Examples:
- Code -> Browser -> Code during implementation usually suggests research.
- One short visit to an unfamiliar app is unknown and should not trigger an intervention.
- Repeated unrelated switching during a sustained task may suggest distraction.
- An explicit learned task/application relationship is related.
- Steam or a clearly named card game during a TypeScript testing task is high-confidence distraction.

Context:
${JSON.stringify(context)}
${validationError ? `The previous response was invalid: ${validationError}. Return the exact required schema.` : ""}`;
}

export async function reasonAboutActivity({ baseUrl, model, context, timeoutMs = 12_000, fetchImpl = fetch }) {
  let validationError = "";
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        prompt: reasoningPrompt(context, validationError),
        options: { temperature: 0, num_predict: 220 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const envelope = await response.json();
    try {
      const reasoning = applyContextPolicy(
        applyReasoningPolicy(validateActivityReasoning(JSON.parse(envelope.response))),
        context,
      );
      return { ...reasoning, latencyMs: Date.now() - startedAt };
    } catch (error) {
      validationError = error instanceof Error ? error.message : "invalid structured output";
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Gemma reasoning failed");
}
