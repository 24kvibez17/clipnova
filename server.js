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
function parseVtt(vttPath, duration) {
  if (!vttPath || !fs.existsSync(vttPath)) return [];
  const raw = fs.readFileSync(vttPath, 'utf8').replace(/\r/g, '');
  const cues = [];
  const time = x => { const a=x.trim().split(':').map(Number); return a.length===3 ? a[0]*3600+a[1]*60+a[2] : a[0]*60+a[1]; };
  for (const block of raw.split(/\n\s*\n/)) {
    const m = block.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/);
    if (!m) continue;
    const cleanTime = x => time(x.replace(',', '.').replace(/\.\d+$/, '')) + Number('0.' + (x.match(/[.,](\d+)$/)?.[1] || '0'));
    const text = block.slice(block.indexOf(m[0]) + m[0].length).replace(/<[^>]*>/g, ' ').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/\[[^\]]*\]|\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
    const a=cleanTime(m[1]), b=cleanTime(m[2]);
    if (text && b>a && a<duration) cues.push({start:a,end:Math.min(b,duration),text});
  }
  return cues;
}
function transcriptHighlights(segments, duration) {
  const windows=[]; const size=Math.min(45,Math.max(20,duration/Math.max(1,Math.ceil(duration/35))));
  const hookWords = /\b(because|secret|mistake|never|always|surprising|imagine|why|how|best|worst|important|actually|but|however|finally|revealed|learn|tip|trick|fail|win|won|lost|crazy|insane|incredible|amazing|problem|solution|remember|truth|wrong|right|first|last|breakthrough|love|hate|fear|shocked|turns out|the reason)\b/ig;
  for(let a=0;a<duration;a+=size){const b=Math.min(duration,a+size);const text=segments.filter(x=>x.end>a&&x.start<b).map(x=>x.text).join(' ').trim();if(text.length<35)continue;
    const words=text.split(/\s+/).length, hooks=(text.match(hookWords)||[]).length, questions=(text.match(/[?]/g)||[]).length, emphatic=(text.match(/[!]/g)||[]).length;
    const score=Math.min(99,Math.round(38+Math.min(24,words/5)+hooks*4+questions*3+emphatic*2));
    const clean=text.replace(/\s+/g,' '); const hook=clean.split(/[.!?]/)[0].slice(0,100) || 'A moment worth watching';
    windows.push({start:Math.max(0,a-2),end:Math.min(duration,b+2),score,reason:'Ranked using transcript hooks, questions and emphasis',hook,caption:hook,hashtags:['#shorts','#clips','#highlights']});
  }
  windows.sort((a,b)=>b.score-a.score); const picked=[];
  for(const h of windows){if(picked.every(x=>h.end<=x.start||h.start>=x.end))picked.push(h);if(picked.length===5)break;}
  return picked.sort((a,b)=>a.start-b.start);
}
async function audioVisualFallback(sourcePath, duration) {
  const size=Math.min(45,Math.max(20,duration/Math.max(1,Math.ceil(duration/35))));
  const scenes=[];
  try {
    const { stdout } = await new Promise((resolve,reject)=>{
      const child=spawn('ffmpeg',['-hide_banner','-i',sourcePath,'-vf',"select='gt(scene,0.28)',showinfo",'-an','-f','null','-'],{stdio:['ignore','pipe','pipe']});
      let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err=(err+d).slice(-20000));child.on('error',reject);child.on('close',()=>resolve({stdout:err}));
    });
    for(const m of stdout.matchAll(/pts_time:([\d.]+)/g))scenes.push(Number(m[1]));
  } catch {}
  const windows=[];
  for(let a=0;a<duration;a+=size){const b=Math.min(duration,a+size); if(b-a<8)continue;
    const cuts=scenes.filter(t=>t>=a&&t<b).length;
    let mean=-60;
    try { const {out}=await new Promise((resolve,reject)=>{const c=spawn('ffmpeg',['-hide_banner','-ss',String(a),'-t',String(b-a),'-i',sourcePath,'-vn','-af','volumedetect','-f','null','-'],{stdio:['ignore','ignore','pipe']});let e='';c.stderr.on('data',d=>e=(e+d).slice(-5000));c.on('error',reject);c.on('close',()=>resolve({out:e}));}); const m=out.match(/mean_volume:\s*(-?[\d.]+) dB/);if(m)mean=Number(m[1]); } catch {}
    const loud=Math.max(0,Math.min(1,(mean+50)/42)); const cutScore=Math.min(1,cuts/12);const score=Math.round(35+loud*35+cutScore*25);
    windows.push({start:Math.max(0,a-1),end:Math.min(duration,b+1),score,reason:'Estimated from audio level and visual scene changes; no transcript was available',hook:'Highlight from your video',caption:'A highlight from this video. Add context before posting.',hashtags:['#shorts','#highlights','#clips']});
  }
  windows.sort((a,b)=>b.score-a.score);const picked=[];for(const h of windows){if(picked.every(x=>h.end<=x.start||h.start>=x.end))picked.push(h);if(picked.length>=Math.min(5,windows.length))break;}return picked.sort((a,b)=>a.start-b.start);
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
    job.progress = 25; job.message = 'Finding engaging moments using free transcript and media analysis…';
    const segments = parseVtt(job.subtitlePath, duration);
    let highlights = transcriptHighlights(segments, duration);
    if (!highlights.length) {
      job.message = 'No usable subtitles found. Scoring audio levels and visual scene changes…';
      highlights = await audioVisualFallback(sourcePath, duration);
    }
    if (!highlights.length) throw new Error('Could not identify candidate moments in this video. Try a shorter video with clearer audio or subtitles.');
    job.analysisMethod = segments.length ? 'free subtitle transcript scoring' : 'audio and visual activity scoring';
    if (job.subtitlePath) { try { fs.unlinkSync(job.subtitlePath); } catch {} }
    job.progress = 48; job.message = 'Ranking candidate moments and preparing vertical clips…';
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
    if (job.subtitlePath) { try { fs.unlinkSync(job.subtitlePath); } catch {} }
  }
}
async function startJob(sourcePath, originalName, sourceType, subtitlePath = null) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'queued', progress: 2, message: 'Job queued…', clips: [], createdAt: Date.now(), originalName, sourceType, subtitlePath };
  jobs.set(id, job);
  setImmediate(() => processVideo(job, sourcePath));
  return job;
}
app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'ClipNova Auto Highlights',
  aiConfigured: true,
  note: 'No paid AI API key required. Uses available subtitles when present; otherwise scores audio and visual activity. Free-host limits apply.'
}));
app.post('/api/jobs', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Paste a valid YouTube URL.' }); }
  const hosts = ['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'];
  if (!['http:','https:'].includes(parsed.protocol) || !hosts.includes(parsed.hostname.toLowerCase())) return res.status(400).json({ error: 'Only YouTube URLs are accepted here.' });
  const id = crypto.randomBytes(8).toString('hex');
  const target = path.join(JOBS, `${id}.%(ext)s`);
  let subtitlePath = null;
  try {
    // Subtitle download is best-effort; videos without captions use media-signal fallback.
    try {
      await run('yt-dlp', ['--no-playlist','--no-warnings','--js-runtimes','deno','--remote-components','ejs:npm','--write-auto-subs','--write-subs','--sub-langs','en.*,en','--sub-format','vtt','--skip-download','-o',target,url], 90*1000);
    } catch {}
    const sub = fs.readdirSync(JOBS).find(n => n.startsWith(id + '.') && /\.vtt$/i.test(n));
    if (sub) subtitlePath = path.join(JOBS, sub);
    await run('yt-dlp', ['--no-playlist','--no-warnings','--js-runtimes','deno','--remote-components','ejs:npm','-f','bv*+ba/b','--merge-output-format','mp4','-o',target,url], 8*60*1000);
    const found = fs.readdirSync(JOBS).find(n => n.startsWith(id + '.') && !n.endsWith('.part') && !n.endsWith('.mp3') && !n.endsWith('.vtt'));
    if (!found) throw new Error('yt-dlp finished but no video file was found.');
    const job = await startJob(path.join(JOBS, found), found, 'youtube', subtitlePath);
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
