// ─── Telnyx Call Recording ────────────────────────────────────────────────────
// Uses the Telnyx Call Control API to start and stop dual-channel MP3 recording.
// Dual-channel separates the agent (outbound track) and prospect (inbound track)
// into two audio channels — useful for quality review and training.
//
// Flow:
//   startRecording() → called at session start → Telnyx begins buffering audio
//   stopRecording()  → called at session end   → Telnyx finalises the file
//   call.recording.saved webhook → index.ts updates calls.recording_url in DB
//
// If recording_enabled = 'false' in settings, both functions are no-ops.

export async function startRecording(callControlId: string, apiKey: string): Promise<void> {
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        format:     'mp3',
        channels:   'dual',    // agent = channel 1, prospect = channel 2
        play_beep:  false,     // no recording beep; legal disclosure handled in system prompt
      }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telnyx record_start failed (${res.status}): ${body}`)
  }
}

export async function stopRecording(callControlId: string, apiKey: string): Promise<void> {
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_stop`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: '{}',
    }
  )

  // 422 = call already ended and recording auto-stopped by Telnyx — not an error.
  // 404 = call_control_id not found (call may have never connected) — log and ignore.
  if (!res.ok && res.status !== 422 && res.status !== 404) {
    const body = await res.text()
    // Non-fatal: the recording may still be saved via the webhook even if stop fails
    console.warn(`[Recording] record_stop returned ${res.status}: ${body}`)
  }
}
