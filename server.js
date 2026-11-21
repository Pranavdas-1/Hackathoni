// Run: SARVAM_API_KEY=... GEMINI_API_KEY=... node server.js   (Node 18+, no npm packages)
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, SK = process.env.SARVAM_API_KEY, GK = process.env.GEMINI_API_KEY;
const STT_MODEL = process.env.SARVAM_STT_MODEL || 'saaras:v4', LLM = process.env.SARVAM_LLM || 'sarvam-105b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const SB = process.env.SARVAM_BASE || 'https://api.sarvam.ai';
const DB = path.join(__dirname, 'data.json'), TR = path.join(__dirname, 'translations.json'), H = 36e5;
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch { return d; } };
const save = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));

function seed() {
  const now = Date.now(), V = { moisture: 15.8, foreign_organic: 0.6, foreign_inorganic: 0.2, damaged_sprouted_pest: 2, immature_shrivelled: 1.5, discoloured: 0.5, lower_variety_mix: 3 };
  // farmer, plot, area, quintals, mill, hours since harvest, [hours harvest->inspection, overrides], delay reported
  const rows = [
    ['Thomas Kurian', 'C-Block 14', 'Kuttanad', 42, 'Kuttanad Mill 1', 20],
    ['Saramma Joseph', 'R-Block 9', 'Kainakary', 30, 'Kainakary Mill', 60],
    ['Biju Mathew', 'Plot 22', 'Champakulam', 55, 'Champakulam Mill', 80],
    ['Lekha Nair', 'Plot 5', 'Kuttanad', 38, 'Kuttanad Mill 2', 110],
    ['Rajan Pillai', 'A-Block 3', 'Kainakary', 47, 'Kainakary Mill', 140, [70, {}]],
    ['Anitha Babu', 'Plot 17', 'Champakulam', 33, 'Champakulam Mill', 170, [85, { moisture: 19.4, foreign_organic: 1.8 }], true],
    ['Sunil Varghese', 'C-Block 6', 'Kuttanad', 60, 'Kuttanad Mill 1', 100, [72, { moisture: 17, discoloured: 1.4 }]],
    ['Mercy George', 'R-Block 2', 'Kainakary', 28, 'Kainakary Mill', 8]
  ];
  return { lots: rows.map((r, i) => {
    const harvest = now - r[5] * H;
    return { id: 'L' + (i + 1), farmer: r[0], plot: r[1], area: r[2], quintals: r[3], mill: r[4],
      harvestAt: new Date(harvest).toISOString(), gps: '9.' + (50 + i * 7) + ', 76.' + (38 + i * 4),
      delayReportedAt: r[7] ? new Date(harvest + 90 * H).toISOString() : null,
      result: r[6] ? { at: new Date(harvest + r[6][0] * H).toISOString(), values: { ...V, ...r[6][1] } } : null, photo: null };
  }) };
}
const db = load(DB, null) || seed(); save(DB, db);
const tcache = load(TR, {});

const body = q => new Promise((ok, no) => { const c = []; let n = 0;
  q.on('data', d => { n += d.length; if (n > 12e6) { no(new Error('Too large')); q.destroy(); } else c.push(d); });
  q.on('end', () => ok(Buffer.concat(c))); q.on('error', no); });
const needKey = (k, n) => { if (!k) throw new Error(n + ' is not set on the server'); };
const jsonOf = s => { const m = String(s).match(/\{[\s\S]*\}/); if (!m) throw new Error('Model did not return JSON'); return JSON.parse(m[0]); };

async function stt(buf, mime) {
  needKey(SK, 'SARVAM_API_KEY');
  const fd = new FormData(), type = (mime || 'audio/webm').split(';')[0];
  fd.append('file', new Blob([buf], { type }), 'voice.' + (type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'));
  fd.append('model', STT_MODEL); fd.append('language_code', 'ml-IN');
  const r = await fetch(SB + '/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': SK }, body: fd });
  const j = await r.json(); if (!r.ok) throw new Error('Speech-to-text failed: ' + JSON.stringify(j));
  return j.transcript || '';
}
const nz = x => String(x || '').toLowerCase().replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/[^a-z0-9]/g, '');
async function extract(text, now) {
  const mills = load(path.join(__dirname, 'standards.json'), {}).mills || [];
  const ist = new Date(new Date(now).getTime() + 5.5 * H);
  const nowIst = ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST, ' + ist.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const sys = `You read a Malayalam farmer's spoken harvest note (already transcribed). Current local time: ${nowIst}. Reply with JSON only: {"name":string|null,"plot":string|null,"quintals":number|null,"mill":string|null,"day_offset":integer|null,"hour":integer|null,"minute":integer|null}. Rules: write the name in English letters. plot is the plot label in English letters and digits, for example "7" or "C-Block 14". Convert Malayalam number words to digits (ഒന്ന്=1, രണ്ട്=2, മൂന്ന്=3, നാല്=4, അഞ്ച്=5, ആറ്=6, ഏഴ്=7, എട്ട്=8, ഒമ്പത്=9, പത്ത്=10, ഇരുപത്തിയഞ്ച്=25). quintals is a number. mill must be exactly one item of this list, or null: ${JSON.stringify(mills)}. Choose by meaning, for example "കുട്ടനാട് മിൽ ഒന്ന്" is "Kuttanad Mill 1"; കൈനകരി is Kainakary, ചമ്പക്കുളം is Champakulam, ആലപ്പുഴ is Alappuzha. day_offset: 0 for today (ഇന്ന്), -1 for yesterday (ഇന്നലെ), -2 for the day before yesterday (മിനിയാന്ന്), 1 for tomorrow (നാളെ). hour is 24-hour: രാവിലെ (morning) uses the hour as said, ഉച്ചയ്ക്ക് (afternoon) 12 to 15, വൈകുന്നേരം (evening) adds 12 to 4-7, രാത്രി (night) adds 12 to 7-11. minute is 0 if not said. Use null for anything not said.`;
  const r = await fetch(SB + '/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': SK },
    body: JSON.stringify({ model: LLM, temperature: 0.1, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('Extraction failed: ' + JSON.stringify(j));
  const o = jsonOf(j.choices[0].message.content), n = nz(o.mill);
  const mill = (n && (mills.find(m => nz(m) === n) || (n.length >= 6 && mills.find(m => nz(m).includes(n) || n.includes(nz(m)))))) || null;
  let harvest_time = null;
  if (Number.isInteger(o.hour) && o.hour >= 0 && o.hour < 24) {
    const d = new Date(ist.getTime() + (Number.isInteger(o.day_offset) ? o.day_offset : 0) * 24 * H), mi = Number.isInteger(o.minute) && o.minute >= 0 && o.minute < 60 ? o.minute : 0;
    harvest_time = `${d.toISOString().slice(0, 10)}T${String(o.hour).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+05:30`;
  }
  return { name: o.name || null, plot: o.plot == null ? null : String(o.plot), quintals: isFinite(+o.quintals) && o.quintals !== null ? +o.quintals : null, mill, harvest_time };
}
const PROMPT = `You are checking a phone photo of harvested paddy spread on a plain surface. Estimate, by area, the percentage of: foreign_matter (chaff, husk fragments, stems and other non-grain material), discoloured (discoloured grains), and damaged_sprouted (damaged, sprouted or pest-affected grains). Give a range for each, not a single number, and be conservative. If the photo is blurry, too dark, too cluttered, or the sample is too small, set confidence to "low" and say why. Reply with JSON only: {"foreign_matter":{"low":number,"high":number},"discoloured":{"low":number,"high":number},"damaged_sprouted":{"low":number,"high":number},"confidence":"low|medium|high","reason":"one short sentence"}`;
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
async function vision(mime, data) {
  if (!GK) throw httpErr(500, 'GEMINI_API_KEY is not set on the server');
  let r, j;
  try {
    r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, { method: 'POST',
      headers: { 'x-goog-api-key': GK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json' } }) });
    j = await r.json().catch(() => ({}));
  } catch (e) { throw httpErr(502, 'Could not reach the Gemini API: ' + e.message); }
  if (!r.ok) {
    const e = j.error || {}, msg = e.message || r.statusText, why = JSON.stringify(e.details || '');
    if (r.status === 429 || e.status === 'RESOURCE_EXHAUSTED') throw httpErr(429, 'Gemini quota or rate limit reached. Wait a minute and try again, or check the free-tier limits.');
    if (/API_KEY_INVALID|API key not valid/i.test(msg + why) || r.status === 401) throw httpErr(401, 'Gemini rejected the API key. Check GEMINI_API_KEY.');
    if (r.status === 403) throw httpErr(403, 'Gemini denied access: ' + msg);
    if (r.status === 404) throw httpErr(502, `Gemini model "${GEMINI_MODEL}" was not found. Set GEMINI_MODEL to an available model.`);
    if (r.status === 400) throw httpErr(400, 'Gemini could not process the request or image: ' + msg);
    throw httpErr(502, `Gemini error ${r.status}: ${msg}`);
  }
  if (j.promptFeedback?.blockReason) throw httpErr(422, 'Gemini blocked this image: ' + j.promptFeedback.blockReason);
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw httpErr(502, 'Gemini returned no answer' + (j.candidates?.[0]?.finishReason ? ' (' + j.candidates[0].finishReason + ')' : ''));
  let o; try { o = jsonOf(text); } catch { throw httpErr(502, 'Gemini returned malformed JSON. Try the photo again.'); }
  const rng = x => { if (!x || !isFinite(+x.low) || !isFinite(+x.high)) throw httpErr(502, 'Gemini returned JSON without the expected estimates. Try the photo again.');
    let lo = Math.max(0, +x.low), hi = Math.max(0, +x.high); if (lo > hi) [lo, hi] = [hi, lo]; return { low: lo, high: hi }; };
  return { foreign_matter: rng(o.foreign_matter), discoloured: rng(o.discoloured), damaged_sprouted: rng(o.damaged_sprouted),
    confidence: ['low', 'medium', 'high'].includes(o.confidence) ? o.confidence : 'low', reason: String(o.reason || '').slice(0, 200) };
}
async function translate(s) {
  if (tcache[s]) return tcache[s]; needKey(SK, 'SARVAM_API_KEY');
  const r = await fetch(SB + '/translate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': SK },
    body: JSON.stringify({ input: s, source_language_code: 'en-IN', target_language_code: 'ml-IN', model: 'sarvam-translate:v1', mode: 'formal' }) });
  const j = await r.json(); if (!r.ok) throw new Error('Translate failed: ' + JSON.stringify(j));
  return (tcache[s] = j.translated_text);
}

function parseResult(b) {
  const std = load(path.join(__dirname, 'standards.json'), {}), v = {};
  for (const k of Object.keys(std.limits)) { v[k] = parseFloat(b.values?.[k]); if (!isFinite(v[k]) || v[k] < 0) return { error: 'Enter a value for every parameter' }; }
  const at = new Date(b.at); if (isNaN(at)) return { error: 'Enter the inspection time' };
  return { at: at.toISOString(), values: v };
}
http.createServer(async (q, s) => {
  const send = (c, o) => { if (s.headersSent) return s.end(); s.writeHead(c, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
  try {
    const p = new URL(q.url, 'http://x').pathname, m = q.method; let x;
    if (m === 'GET' && p === '/api/config') return send(200, load(path.join(__dirname, 'standards.json')));
    if (m === 'GET' && p === '/api/lots') return send(200, db.lots);
    if (m === 'POST' && p === '/api/lots') {
      const b = JSON.parse(await body(q)); if (!b.farmer || !b.plot || !(+b.quintals > 0) || !b.harvestAt) return send(400, { error: 'Fill name, plot, quintals and harvest time' });
      const lot = { id: 'L' + Date.now().toString(36), farmer: String(b.farmer), plot: String(b.plot), area: String(b.area || ''), quintals: +b.quintals,
        mill: String(b.mill || ''), harvestAt: new Date(b.harvestAt).toISOString(), gps: String(b.gps || ''), delayReportedAt: null, result: null, photo: null };
      db.lots.unshift(lot); save(DB, db); return send(200, lot);
    }
    if (m === 'POST' && (x = p.match(/^\/api\/lots\/(\w+)\/(delay|result|report|appeal|retest|retestresult|demand)$/))) {
      const lot = db.lots.find(l => l.id === x[1]); if (!lot) return send(404, { error: 'Lot not found' });
      if (x[2] === 'delay') { lot.delayReportedAt ||= new Date().toISOString(); }
      else if (x[2] === 'report') { lot.reportedAt ||= new Date().toISOString(); }
      else { const b = JSON.parse(await body(q)), k = x[2], now = new Date().toISOString();
        if (k === 'appeal') { lot.appeal ||= { at: now, reason: String(b.reason || '').slice(0, 500) }; lot.retest ||= { requestedAt: now, reason: 'Appeal against mill figures', result: null }; }
        else if (k === 'demand') { const d = parseFloat(b.kgPer100); if (!isFinite(d) || d < 0 || d > 50) return send(400, { error: 'Enter the extra kg asked per 100 kg (0 to 50)' }); lot.demand = { kgPer100: d, at: now }; }
        else if (k === 'retest') { lot.retest ||= { requestedAt: now, reason: String(b.reason || 'Re-check requested').slice(0, 300), result: null }; }
        else { const r = parseResult(b); if (r.error) return send(400, { error: r.error });
          if (k === 'retestresult') { if (!lot.retest) return send(400, { error: 'No re-test was requested' }); lot.retest.result = r; } else lot.result = r; } }
      save(DB, db); return send(200, lot);
    }
    if (m === 'POST' && p === '/api/voice') {
      const transcript = await stt(await body(q), q.headers['content-type']);
      const fields = transcript ? await extract(transcript, q.headers['x-now'] || new Date().toISOString()) : {};
      return send(200, { transcript, fields });
    }
    if (m === 'POST' && p === '/api/photo') {
      const b = JSON.parse(await body(q)), lot = db.lots.find(l => l.id === b.lotId); if (!lot) return send(404, { error: 'Lot not found' });
      const mime = b.mime || 'image/jpeg';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return send(415, { error: 'Upload a JPEG, PNG or WebP photo' });
      if (typeof b.data !== 'string' || b.data.length < 100 || !/^[A-Za-z0-9+/=\s]+$/.test(b.data)) return send(400, { error: 'The photo upload was empty or damaged. Take the photo again.' });
      if (b.data.length > 9e6) return send(413, { error: 'The photo is too large' });
      lot.photo = { ...(await vision(mime, b.data)), sampleMixed: b.sampleMixed === true, at: new Date().toISOString() }; save(DB, db); return send(200, lot);
    }
    if (m === 'POST' && p === '/api/translate') {
      const { texts } = JSON.parse(await body(q)), out = [];
      for (let i = 0; i < texts.length; i += 5) out.push(...await Promise.all(texts.slice(i, i + 5).map(translate)));
      save(TR, tcache); return send(200, { texts: out });
    }
    if (m === 'GET') {
      const f = path.join(__dirname, 'public', 'index.html');
      if (!fs.existsSync(f)) return send(500, { error: 'public/index.html is missing. Keep index.html inside a folder named public next to server.js.' });
      const html = fs.readFileSync(f); s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return s.end(html);
    }
    send(404, { error: 'Not found' });
  } catch (e) { if (!(e instanceof SyntaxError) && !e.status) console.error(e); send(e instanceof SyntaxError ? 400 : e.status || 500, { error: e instanceof SyntaxError ? 'Invalid request body' : e.message }); }
}).listen(PORT, () => console.log('Paddy lots running at http://localhost:' + PORT));