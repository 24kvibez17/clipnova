# ClipNova Auto Highlights v2

This version replaces manual start/end controls with an automated pipeline:
1. Accept a YouTube URL or a user-provided video file.
2. Extract audio with FFmpeg.
3. Transcribe audio using OpenAI's audio transcription API.
4. Ask an AI model to rank moments from transcript content and timestamps.
5. Cut selected moments with FFmpeg, format vertical 9:16, and generate post captions.

## Important requirements and limitations
- **Requires an OpenAI API key** set as `OPENAI_API_KEY` in Render. API usage is not guaranteed to be free; check current pricing and usage limits before using it.
- YouTube extraction via yt-dlp is best-effort and may fail due to YouTube restrictions, video permissions, age/region limits, or changes to YouTube. Only process videos you own or are authorized to process.
- A transcript can help identify interesting dialogue, but it cannot reliably judge visual excitement without a vision-analysis stage. This implementation ranks transcript moments using AI.
- Render free services have limited RAM, CPU, request duration, and ephemeral disk. Long videos can fail or take a long time, and generated clips may disappear on restart/redeploy. Use short test videos first.
- This is a deployable starter, not a guarantee of production reliability. No external service can promise that every URL works.
- For large files or public production, use persistent object storage and a background job worker.

## Deploy to your existing Render service
1. Back up your current GitHub repository first.
2. Upload/replace the files in this project in the root of `24kvibez17/clipnova` (keep the repository name).
3. In Render → your `clipnova` service → Environment, add `OPENAI_API_KEY` with your key. Never put the key in GitHub or frontend code.
4. Trigger **Manual Deploy → Clear build cache & deploy** (or the closest available clean-build option).
5. Open `/api/health` on your Render URL to verify the service is running.
6. Upload a short video you own first, or try a public YouTube URL you are authorized to process.

## Local development
Requires Docker, or Node 20 + FFmpeg + yt-dlp + Deno installed. Set `OPENAI_API_KEY` in the environment and run `npm start`.

## Endpoints
- `GET /api/health`
- `POST /api/jobs` JSON `{ "url": "https://www.youtube.com/watch?v=..." }`
- `POST /api/upload` multipart field `video`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/clips`
- `GET /clips/:filename`
