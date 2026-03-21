export type ScenarioType =
  | 'voicemail' | 'not_interested' | 'wrong_person'
  | 'interested' | 'callback_request' | 'unknown'

export function detectScenario(transcript: string): ScenarioType {
  const text = transcript.toLowerCase().trim()

  const voicemailPhrases = ['leave a message', 'after the tone', 'voicemail', 'not available to take your call']
  if (voicemailPhrases.some(p => text.includes(p))) return 'voicemail'

  const notInterestedPhrases = [
    'not interested', 'no thank you', 'no thanks', 'please remove',
    "don't call", 'stop calling', 'already have', 'not looking', 'bye', 'goodbye'
  ]
  if (notInterestedPhrases.some(p => text.includes(p))) return 'not_interested'

  const wrongPersonPhrases = [
    'not the right person', 'not my department', 'speak to', 'talk to',
    "i'll pass", 'not in', 'not here', "i'm just", "i only",
    'front desk', 'receptionist', 'manager is', 'owner is', 'director is'
  ]
  if (wrongPersonPhrases.some(p => text.includes(p))) return 'wrong_person'

  const callbackPhrases = [
    'call back', 'call me back', 'better time', 'later',
    'busy right now', 'in a meeting', 'bad time', 'ring me'
  ]
  if (callbackPhrases.some(p => text.includes(p))) return 'callback_request'

  const interestedPhrases = [
    'tell me more', 'interested', 'sounds good', 'yes', 'yeah',
    'absolutely', 'definitely', 'how much', 'what does it cost',
    'how does it work', 'book a meeting', 'demo', 'sounds interesting', 'go on'
  ]
  if (interestedPhrases.some(p => text.includes(p))) return 'interested'

  return 'unknown'
}

export function buildSystemPrompt(systemPrompt: string): string {
  return `${systemPrompt}

CRITICAL VOICE RULES — ALWAYS FOLLOW:
1. Keep every response under 40 words. You are speaking aloud not writing.
2. Never use bullet points, lists, or markdown. Speak naturally.
3. Never hang up without getting at least one of: decision maker name, callback time, or email.
4. If someone is busy ask: "What time works better — morning or afternoon?"
5. If not the right person ask: "Who would be the right person to speak to?"
6. Never try to close a sale. Your ONLY job is to detect interest and book a callback.
7. If interested say: "Great! I will have one of our specialists call you back. Morning or afternoon?"
8. Sound natural. Short sentences. Real human speech patterns.
9. If you detect a voicemail greeting say nothing and end immediately.
10. The call has a strict maximum duration — wrap up gracefully before time runs out.`
}
