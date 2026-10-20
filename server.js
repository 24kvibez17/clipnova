const express = require('express');
const multer = require('multer');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const app = express();
const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const JOBS = path.join(ROOT, 'jobs');
const CLIPS = path.join(JOBS, 'clips');
fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(CLIPS, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use('/clips', express.static(CLIPS, { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  dest: JOBS,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^video\//.test(file.mimetype) || /\.(mp4|mov|mkv|webm|m4v)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Upload a video file such as MP4, MOV, MKV, or WebM.'));
  }
});

const jobs = new Map();
function publicJob(j) {
  return {
    id: j.id, status: j.status, progress: j.progress, message: j.message,
    error: j.error || null, clips: j.clips || [], captions: j.captions || null
  };
}
function run(cmd, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Processing timed out. Try a shorter video.')); }, timeoutMs);
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-8000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(err.slice(-1400) || `Processing failed (exit ${code}).`));
    });
  });
}
async function openAI(pathname, body, isForm = false) {
  if (!process.env.OPENAI_API_KEY) throw new Error('AI is not configured yet. Add OPENAI_API_KEY in Render → Environment.');
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  let bodyOut = body;
  if (!isForm) { headers['Content-Type'] = 'application/json'; bodyOut = JSON.stringify(body); }
  const response = await fetch(`https://api.openai.com/v1${pathname}`, { method: 'POST', headers, body: bodyOut });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI request failed (${response.status}). Check API key and account limits.`);
  return data;
}
async function transcribe(audioPath) {
  const stat = fs.statSync(audioPath);
  if (stat.size > 24 * 1024 * 1024) {
    // Re-encode mono 16 kHz audio at a low bitrate so long videos can fit common upload limits.
    const compressed = audioPath + '.mp3';
    await run('ffmpeg', ['-y', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', compressed]);
    audioPath = compressed;
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const result = await openAI('/audio/transcriptions', form, true);
  try { if (audioPath.endsWith('.mp3') && audioPath !== audioPath) fs.unlinkSync(audioPath); } catch {}
  const segments = (result.segments || []).map(s => ({
    start: Number(s.start), end: Number(s.end), text: String(s.text || '').trim()
  })).filter(s => s.end > s.start && s.text);
  if (!segments.length && result.text) return [{ start: 0, end: 999999, text: result.text }];
  return segments;
}
function transcriptWindow(segments, duration, count = 24) {
  const max = Math.max(1, duration);
  const windowSize = Math.max(15, Math.min(45, max / count));
  const out = [];
  for (let start = 0; start < max; start += windowSize) {
    const end = Math.min(max, start + windowSize);
    const text = segments.filter(s => s.end > start && s.start < end).map(s => s.text).join(' ').trim();
    if (text.length >= 25) out.push({ start: Math.max(0, start - 2), end: Math.min(max, end + 2), transcript: text.slice(0, 2400) });
  }
  return out;
}
async function chooseHighlights(segments, duration) {
  const windows = transcriptWindow(segments, duration);
  if (!windows.length) throw new Error('No usable speech transcript was found. This starter currently scores spoken content; silent or music-only videos need a different analysis method.');
  const prompt = `You are an editor selecting engaging short-form video moments from a transcript. Rank moments for a general social audience using clear hooks, surprising claims, useful tips, humor, emotional payoff, strong opinions, story turns, or self-contained ideas. Avoid intros, dead air, repetitive content, and moments that need lots of missing context. Only select ranges within the supplied windows. Return JSON only: {"highlights":[{"start":number,"end":number,"score":1-100,"reason":"short reason","hook":"short opening hook","caption":"social post caption","hashtags":["#tag"]}]}. Select up to 5 non-overlapping highlights, ideally 20-55 seconds each, never over 60 seconds. Make captions factual and don't invent claims.`;
  const result = await openAI('/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ duration_seconds: duration, transcript_windows: windows }) }
    ]
  });
  const raw = result.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('AI returned an unreadable highlight list. Try again.'); }
  const highlights = (parsed.highlights || []).map(h => ({
    start: Math.max(0, Number(h.start)), end: Math.min(duration, Number(h.end)),
    score: Math.max(1, Math.min(100, Number(h.score) || 50)),
    reason: String(h.reason || 'Selected from transcript'),
    hook: String(h.hook || 'Watch this moment'),
    caption: String(h.caption || h.hook || 'Watch this moment'),
    hashtags: Array.isArray(h.hashtags) ? h.hashtags.map(String).slice(0, 8) : []
  })).filter(h => Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start && h.end - h.start >= 8);
  highlights.sort((a,b) => b.score - a.score);
  const selected = [];
  for (const h of highlights) {
    if (selected.every(x => h.end <= x.start || h.start >= x.end)) selected.push(h);
    if (selected.length >= 5) break;
  }
  if (!selected.length) throw new Error('AI could not find suitable clips in this transcript. Try a longer video with clear speech.');
  return selected.sort((a,b) => a.start - b.start);
}
async function processVideo(job, sourcePath) {
  try {
    job.status = 'processing'; job.progress = 10; job.message = 'Reading video duration and extracting audio…';
    const probe = await new Promise((resolve, reject) => {
      const child = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',sourcePath]);
      let out = '', err = '';
      child.stdout.on('data', d => out += d.toString()); child.stderr.on('data', d => err += d.toString());
      child.on('error', reject); child.on('close', code => code === 0 && Number(out.trim()) > 0 ? resolve(Number(out.trim())) : reject(new Error(err || 'Could not read video duration.')));
    });
    if (probe > 2 * 60 * 60) throw new Error('Videos over 2 hours are not supported in this starter. Try a shorter source.');
    const duration = probe;
    const audio = path.join(JOBS, `${job.id}.mp3`);
    job.progress = 20; job.message = 'Transcribing speech for highlight detection…';
    await run('ffmpeg', ['-y','-i',sourcePath,'-vn','-ac','1','-ar','16000','-b:a','64k',audio]);
    const segments = await transcribe(audio);
    try { fs.unlinkSync(audio); } catch {}
    job.progress = 48; job.message = 'AI is ranking the most engaging moments…';
    const highlights = await chooseHighlights(segments, duration);
    job.progress = 62; job.message = `Creating ${highlights.length} vertical clips…`;
    const clips = [];
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const filename = `${job.id}-clip-${i+1}.mp4`;
      const output = path.join(CLIPS, filename);
      const length = Math.min(60, h.end - h.start);
      const vf = "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280";
      await run('ffmpeg', ['-y','-ss',String(h.start),'-i',sourcePath,'-t',String(length),'-vf',vf,'-c:v','libx264','-preset','veryfast','-crf','24','-c:a','aac','-b:a','128k','-movflags','+faststart',output]);
      clips.push({
        number: i+1, filename, url: `/clips/${filename}`,
        start: h.start, end: Math.min(h.end, h.start + length), score: h.score,
        reason: h.reason, hook: h.hook, caption: h.caption,
        hashtags: h.hashtags, duration: length
      });
      job.progress = 62 + Math.round(((i+1)/highlights.length)*32);
    }
    job.clips = clips;
    job.captions = clips.map(c => ({ clip: c.number, caption: c.caption, hashtags: c.hashtags, hook: c.hook }));
    job.status = 'completed'; job.progress = 100; job.message = `Done — ${clips.length} clips are ready to preview and download.`;
  } catch (e) {
    job.status = 'failed'; job.error = e.message || 'Processing failed.'; job.message = 'We could not finish this video.';
  } finally {
    try { fs.unlinkSync(sourcePath); } catch {}
  }
}
async function startJob(sourcePath, originalName, sourceType) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'queued', progress: 2, message: 'Job queued…', clips: [], createdAt: Date.now(), originalName, sourceType };
  jobs.set(id, job);
  setImmediate(() => processVideo(job, sourcePath));
  return job;
}
app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'ClipNova Auto Highlights',
  aiConfigured: Boolean(process.env.OPENAI_API_KEY),
  note: 'Automatic transcript-based highlight selection; source access and API usage limits apply.'
}));
app.post('/api/jobs', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Paste a valid YouTube URL.' }); }
  const hosts = ['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'];
  if (!['http:','https:'].includes(parsed.protocol) || !hosts.includes(parsed.hostname.toLowerCase())) return res.status(400).json({ error: 'Only YouTube URLs are accepted here.' });
  const id = crypto.randomBytes(8).toString('hex');
  const target = path.join(JOBS, `${id}.%(ext)s`);
  try {
    await run('yt-dlp', ['--no-playlist','--no-warnings','--js-runtimes','deno','--remote-components','ejs:npm','-f','bv*+ba/b','--merge-output-format','mp4','-o',target,url], 8*60*1000);
    const found = fs.readdirSync(JOBS).find(n => n.startsWith(id + '.') && !n.endsWith('.part') && !n.endsWith('.mp3'));
    if (!found) throw new Error('yt-dlp finished but no video file was found.');
    const job = await startJob(path.join(JOBS, found), found, 'youtube');
    res.status(202).json(publicJob(job));
  } catch (e) {
    for (const n of fs.readdirSync(JOBS).filter(n => n.startsWith(id + '.'))) { try { fs.unlinkSync(path.join(JOBS, n)); } catch {} }
    res.status(500).json({ error: `Could not retrieve this YouTube video. Try a video you own or upload an authorized video file. Details: ${(e.message || 'extraction failed').slice(-700)}` });
  }
});
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a video file first.' });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.mp4';
  const finalPath = path.join(JOBS, `${crypto.randomBytes(8).toString('hex')}${ext}`);
  try {
    fs.renameSync(req.file.path, finalPath);
    const job = await startJob(finalPath, req.file.originalname, 'upload');
    res.status(202).json(publicJob(job));
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message || 'Upload could not be processed.' });
  }
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found. Jobs are stored in memory and may be lost after a restart.' });
  res.json(publicJob(job));
});
app.get('/api/jobs/:id/clips', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ clips: job.clips || [], captions: job.captions || [] });
});
app.use((err, _req, res, _next) => {
  res.status(err instanceof multer.MulterError ? 413 : 400).json({ error: err.message || 'Request failed.' });
});
app.listen(PORT, '0.0.0.0', () => console.log(`ClipNova Auto Highlights listening on ${PORT}`));
