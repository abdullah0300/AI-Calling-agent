export type ScenarioType = 'voicemail' | 'not_interested' | 'llm'

// Two hard exits — everything else goes directly to the LLM.
//
// voicemail: the LLM must never try to respond to a machine greeting.
//   Instant silent hang-up is the only correct action.
//
// not_interested: compliance and legal signal. "Don't call me", "remove me",
//   "stop calling" must be respected without argument. Sending these to the LLM
//   risks it trying to overcome the objection, which is a regulatory problem.
//
// Everything else — wrong person, callback request, questions, objections,
// interest signals, confusion — the LLM handles far better than a phrase list.
// Keyword matching cannot understand context: "yes" inside "yes but I already
// have a provider" is not the same as a standalone "yes".
export function detectScenario(transcript: string): ScenarioType {
  const text = transcript.toLowerCase().trim()

  const voicemailPhrases = [
    'leave a message', 'after the tone', 'voicemail',
    'not available to take your call', 'please leave a message',
  ]
  if (voicemailPhrases.some(p => text.includes(p))) return 'voicemail'

  const notInterestedPhrases = [
    'not interested', 'no thank you', 'no thanks',
    'please remove', "don't call", 'stop calling',
    'do not call', 'remove me', 'take me off',
    // 'bye' intentionally excluded — substring matches "maybe", "hereby" etc.
    // 'already have' intentionally excluded — objection for LLM to handle.
  ]
  if (notInterestedPhrases.some(p => text.includes(p))) return 'not_interested'

  return 'llm'
}

interface LeadContext {
  businessName?: string
  industry?: string
  city?: string
}

// Default voice rules used for legacy flat prompts (backward compatibility).
// New structured prompts ([Identity]/[Style]/[Task] format) carry their own rules.
const VOICE_STYLE = `- Keep every response under 30 words. You are speaking aloud, not writing.
- Never use bullet points, lists, or markdown. Speak naturally.
- Short sentences. Real human speech patterns.
- Never pushy or salesy. Warm and confident.
- Always begin your reply with a 1–3 word natural filler before your main sentence — choose from: "Mm, right —", "Yeah —", "Got it —", "Sure —", "Ah okay —", "Right —". This makes you sound human, not robotic.
- Use "..." mid-sentence for a natural thinking pause when appropriate. Example: "Yeah — we help businesses like yours... get more leads without extra staff."`

const VOICE_GUIDELINE = `- Ask only one question at a time — never stack two questions.
- Spell numbers in words (say "five hundred" not "500").
- Never quote prices or try to sell directly.
- Your ONLY goal is to detect interest and arrange a specialist callback.
- Never hang up without getting at least one of: decision maker name, callback time, or email.
- The call has a strict maximum duration — wrap up gracefully before time runs out.`

const VOICE_ERROR_HANDLING = `- If you did not understand: "I am sorry, I did not quite catch that. Could you say that again?"
- If asked something outside your scope: "That is a great question for our specialist — they will cover that on the callback."
- If the line goes silent, gently prompt: "Hello, are you still there?"
- If you detect a voicemail greeting, say nothing and end the call immediately.`

export function buildSystemPrompt(systemPrompt: string, context?: LeadContext): string {
  // Inject prospect context line (used in both structured and legacy paths)
  const contextLine = context?.businessName
    ? `\nYou are currently speaking with someone at ${context.businessName}${context.industry ? `, a ${context.industry} business` : ''}${context.city ? ` in ${context.city}` : ''}.`
    : ''

  // Structured Vapi-format prompt — user has already defined [Identity]/[Style]/[Task] etc.
  // Just append prospect context so the LLM knows who it is speaking with.
  const isStructured = /\[(Identity|Style|Task|Response Guideline|Error Handling)\]/i.test(systemPrompt)
  if (isStructured) {
    return contextLine
      ? `${systemPrompt}\n\n[Context]${contextLine}`
      : systemPrompt
  }

  // Legacy flat prompt — wrap in Vapi structure so the LLM gets the same quality guidance.
  return `[Identity]
${systemPrompt.trim()}${contextLine}

[Style]
${VOICE_STYLE}

[Response Guideline]
${VOICE_GUIDELINE}

[Task]
1. Greet the prospect and introduce yourself and your company.
<wait for user response>
2. State the purpose of the call in one sentence.
<wait for user response>
3. Ask a qualifying question to gauge interest.
<wait for user response>
4. If interested, offer a specialist callback and ask: "Morning or afternoon works better?"
<wait for user response>
5. Confirm the callback slot, thank them, and close the call politely.

[Error Handling]
${VOICE_ERROR_HANDLING}`
}
