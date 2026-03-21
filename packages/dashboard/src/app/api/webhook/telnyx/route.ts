import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const event = body?.data?.event_type
  const payload = body?.data?.payload
  const wsServerUrl = process.env.WS_SERVER_URL!

  console.log('[Telnyx Webhook]', event)

  switch (event) {
    case 'call.answered':
      const callControlId = payload?.call_control_id
      if (callControlId) {
        await fetch(`${wsServerUrl}/session/start/${callControlId}`, { method: 'POST' })
          .catch(err => console.error('Failed to start session:', err))
      }
      break

    case 'call.machine.detection.ended':
      if (payload?.result === 'machine' && payload?.call_control_id) {
        await fetch(`${wsServerUrl}/session/start/${payload.call_control_id}`, { method: 'POST' })
          .catch(() => {})
      }
      break
  }

  return NextResponse.json({ received: true })
}
