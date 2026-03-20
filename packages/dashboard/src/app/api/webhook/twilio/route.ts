import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  // Twilio sends form-encoded data
  const body = await req.formData()
  const callStatus = body.get('CallStatus')
  const callSid = body.get('CallSid')

  console.log('[Twilio Webhook] CallStatus:', callStatus, 'CallSid:', callSid)

  // Future: handle Twilio call status updates here

  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' }
  })
}
