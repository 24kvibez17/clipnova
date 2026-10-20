const express = require('express');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const app = express();
const PORT = process.env.PORT || 4173;
const OUT = path.join(__dirname, 'clips');
fs.mkdirSync(OUT, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use('/clips', express.static(OUT, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ClipNova', note: 'Manual time-range clipping only; AI highlight detection is not implemented.' }));
function run(cmd, args, timeoutMs = 12 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Processing timed out. Try a shorter segment or another authorized source.')); }, timeoutMs);
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-5000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.includes('Sign in') ? 'This video requires sign-in or is restricted.' : (err.slice(-700) || `Processing failed (exit ${code}).`))); });
  });
}
app.post('/api/clips', async (req, res) => {
  const { url, start, end } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ ok: false, error: 'Enter a valid video URL.' }); }
  const ytHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'];
  if (!['http:', 'https:'].includes(parsed.protocol) || !ytHosts.includes(parsed.hostname.toLowerCase())) return res.status(400).json({ ok: false, error: 'This endpoint currently accepts YouTube URLs only.' });
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e - s > 180) return res.status(400).json({ ok: false, error: 'Choose a valid clip range up to 180 seconds.' });
  const id = crypto.randomBytes(8).toString('hex'); const filename = `clipnova-${id}.mp4`; const output = path.join(OUT, filename); const temp = path.join(OUT, `${id}.%(ext)s`);
  try {
    // Intended for videos the user owns or is authorized to process.
   
await run('yt-dlp', [
  '--no-playlist',
  '--no-warnings',
  '--js-runtimes', 'deno',
  '--remote-components', 'ejs:npm',
  '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
  '--merge-output-format', 'mp4',
  '-o', temp,
  url
]);

    const downloaded = fs.readdirSync(OUT).filter(n => n.startsWith(id + '.')).map(n => path.join(OUT, n)).find(p => !p.endsWith('.part'));
    if (!downloaded) throw new Error('Downloaded video file was not found.');
    await run('ffmpeg', ['-y', '-ss', String(s), '-i', downloaded, '-t', String(e-s), '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', output]);
    try { fs.unlinkSync(downloaded); } catch {}
    const stat = fs.statSync(output);
    res.json({ ok: true, filename, sizeBytes: stat.size, clipUrl: `/clips/${filename}` });
  } catch (err) {
    for (const n of fs.readdirSync(OUT).filter(n => n.startsWith(id + '.'))) { try { fs.unlinkSync(path.join(OUT, n)); } catch {} }
    res.status(500).json({ ok: false, error: err.message || 'Video processing failed.' });
  }
});
app.listen(PORT, '0.0.0.0', () => console.log(`ClipNova listening on ${PORT}`));
