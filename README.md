# ClipNova Free Online v3

This build removes the OpenAI API dependency and does not require a paid AI key.

## How free analysis works
- YouTube URL jobs try to fetch English captions/subtitles when available and rank transcript windows using transparent heuristics (hook words, questions, emphasis, and transcript density).
- If subtitles are unavailable, the server scores candidate windows using audio loudness and visual scene changes. Uploaded videos use this fallback.
- FFmpeg renders actual vertical MP4 clips. Captions/hooks/hashtags are generated with simple templates and transcript text, not a generative AI model.

This is a free, heuristic highlight finder—not a semantic AI model. It can miss context, humor, or the truly best moment. Subtitles depend on source availability. YouTube extraction may fail because of platform restrictions or changes. Only process videos you own or have permission to use.

## Deploy to the existing Render service
1. Back up your GitHub repository before replacing files.
2. Upload the files in this ZIP to the root of your existing `clipnova` repository. Keep the same repository name.
3. Commit the changes and let Render redeploy. No `OPENAI_API_KEY` environment variable is needed. You can remove that variable from Render if it exists.
4. Check `https://YOUR-SERVICE.onrender.com/api/health` and verify `ok: true`.
5. Test with a short video you are authorized to process.

## Free hosting caveats
Render free services sleep when idle, have limited compute and ephemeral disk, and may restart. Jobs and generated clips can disappear on restart/redeploy; long videos can time out or exhaust memory/disk. This package cannot guarantee unlimited or always-on processing on free hosting.

## Local smoke test
Requires Node.js, FFmpeg/ffprobe, yt-dlp, and Deno (for supported YouTube extraction). Run `npm install`, then `npm start`; open `http://localhost:4173`.
