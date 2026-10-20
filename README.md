# ClipNova — hosted starter

This is a deployable starter, not a finished AI highlight detector. It currently lets a user paste a YouTube URL, choose start/end timestamps (up to 180 seconds), and asks the server to create an MP4 clip. Generated files are playable/downloadable from the page.

## Important limits
- Only process videos you own or have permission to download/edit. Respect YouTube's terms and the source video's rights.
- YouTube may block automated access; age-restricted, private, members-only, live, or otherwise restricted videos may fail.
- The free Render filesystem is ephemeral and the service may sleep; generated clips can disappear after restart/redeploy. Video processing may exceed free resource limits.
- Automatic AI highlight detection, captions, accounts, and persistent cloud storage are NOT implemented.

## Deploy using a browser (no local install required)
1. Download and unzip this project on your computer.
2. Create a GitHub repository at https://github.com/new.
3. In the new repository, choose **Add file → Upload files** and upload the extracted *contents* of this folder (not the ZIP itself). Commit the upload.
4. Go to https://render.com/ and sign in, choose **New → Web Service**, connect the GitHub repository, and select Docker runtime if asked. The included `render.yaml` is a starting blueprint; follow Render's current deployment prompts.
5. After deployment, open the Render HTTPS URL. The page and `/api/clips` API are served from the same site, so no localhost URL needs changing.
6. Test `https://YOUR-SERVICE.onrender.com/api/health`; it should return JSON with `ok: true`.

## Local requirements (optional)
Docker, ffmpeg, yt-dlp, and Node are required for local execution. On hosted deployment the Docker image installs these.
