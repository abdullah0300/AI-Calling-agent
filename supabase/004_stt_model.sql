-- Add active_stt_model to settings table (defaults to nova-2, available on all Deepgram plans)
INSERT INTO public.settings (key, value)
VALUES ('active_stt_model', 'nova-2')
ON CONFLICT (key) DO NOTHING;
