/**
 * WebCheat panel — CE penceresi.
 * Hedef sekmeyi/frame'i secer, agent'a RPC atar, sonuclari gosterir.
 */
'use strict';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Durum
 * ------------------------------------------------------------------ */
const state = {
  targets: [],
  tabId: null,
  frameId: null,
  regionId: null,
  scanning: false,
  hasResults: false,
  speed: 1,
  prevSpeed: 1,
  regionPoll: null,
  list: [],        // adres listesi: {key, desc, region, addr, type, value, frozen, freezeId}
  keySeq: 0
};

const FIRST_CMPS = [
  ['eq', 'Tam deger'],
  ['unknown', 'Bilinmeyen baslangic degeri'],
  ['gt', 'Buyuktur'],
  ['lt', 'Kucuktur'],
  ['between', 'Arasinda']
];

const NEXT_CMPS = [
  ['eq', 'Tam deger'],
  ['changed', 'Degisti'],
  ['unchanged', 'Degismedi'],
  ['inc', 'Artti'],
  ['dec', 'Azaldi'],
  ['incBy', 'Su kadar artti'],
  ['decBy', 'Su kadar azaldi'],
  ['gt', 'Buyuktur'],
  ['lt', 'Kucuktur'],
  ['between', 'Arasinda']
];

const NO_VALUE = new Set(['unknown', 'changed', 'unchanged', 'inc', 'dec']);

/* ------------------------------------------------------------------ *
 * Mesajlasma
 * ------------------------------------------------------------------ */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ __wcePanel: true, ...msg }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || { error: 'bos yanit' });
    });
  });
}

async function rpc(cmd, args = {}) {
  if (state.tabId === null || state.frameId === null) return { error: 'hedef secilmedi' };
  return bg({ op: 'rpc', tabId: state.tabId, frameId: state.frameId, payload: { cmd, args } });
}

/** Secili frame'i degil, belirtilen frame'i sorgular. */
async function rpcFrame(frameId, cmd, args = {}) {
  if (state.tabId === null) return { error: 'sekme secilmedi' };
  return bg({ op: 'rpc', tabId: state.tabId, frameId, payload: { cmd, args } });
}

function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function setStatus(text, cls) {
  $('statusText').textContent = text;
  const dot = $('dot');
  dot.className = 'dot' + (cls ? ' ' + cls : '');
}

/* ------------------------------------------------------------------ *
 * Hedef secimi
 * ------------------------------------------------------------------ */
async function refreshTargets() {
  setStatus('sekmeler taraniyor...', 'busy');
  const res = await bg({ op: 'listTargets' });
  if (res.error) { setStatus('hata: ' + res.error); return; }

  state.targets = res.result || [];
  const tabSel = $('tabSel');
  const keepTab = state.tabId;
  tabSel.textContent = '';

  if (!state.targets.length) {
    tabSel.append(new Option('— agent yuklu sekme yok —', ''));
    $('frameSel').textContent = '';
    setStatus('sekme bulunamadi');
    toast('Oyunun sekmesini bir kez yenile (uzanti kurulmadan once acilmis sayfalarda agent yok).', 6000);
    return;
  }

  for (const t of state.targets) {
    const mark = t.hasMemory ? '[WASM] '
      : t.discarded ? '[askida] '
      : t.hasAgent ? ''
      : '[agent yok] ';
    const label = mark + (t.title.length > 54 ? t.title.slice(0, 54) + '…' : t.title);
    tabSel.append(new Option(label, String(t.tabId)));
  }

  const found = state.targets.find((t) => t.tabId === keepTab);
  const pick = found || state.targets[0];
  tabSel.value = String(pick.tabId);
  selectTab(pick.tabId);
}

function selectTab(tabId) {
  state.tabId = tabId;
  clearTimeout(state.regionPoll);
  const tab = state.targets.find((t) => t.tabId === tabId);
  const frameSel = $('frameSel');
  const regionSel = $('regionSel');
  frameSel.textContent = '';
  if (!tab) return;

  // Agent yok: content script bu sekmeye hic enjekte olmamis (sekme uzanti
  // kurulmadan/yenilenmeden once acilmis). Kullaniciya ne yapacagini soyle.
  if (!tab.frames.length) {
    state.frameId = null;
    state.regionId = null;
    frameSel.append(new Option(tab.discarded ? '— sekme askida —' : '— agent yok —', ''));
    regionSel.textContent = '';
    regionSel.append(new Option('— agent yok —', ''));
    setStatus(tab.discarded ? 'sekme askida' : 'agent yok', '');
    toast(tab.discarded
      ? 'Bu sekme Chrome tarafindan uykuya alinmis. Sekmeye bir gecip geri gel, sonra Yenile.'
      : 'Bu sekmede agent yok. "Sekmeyi Yenile"ye bas — hook\'lar oyun yuklenmeden once takilmali.', 6000);
    return;
  }

  for (const f of tab.frames) {
    const n = f.regions.length;
    const where = f.top ? 'ana sayfa' : 'iframe #' + f.frameId;
    const url = f.url.length > 52 ? f.url.slice(0, 52) + '…' : f.url;
    frameSel.append(new Option(`${where} — ${url}${n ? `  (${n} bellek)` : ''}`, String(f.frameId)));
  }

  const best = tab.frames[0];
  frameSel.value = String(best.frameId);
  selectFrame(best.frameId);
}

/**
 * Frame secildiginde bolgeleri CANLI sorar — listTargets sirasindaki
 * onbellege guvenmez. Oyun WASM'ini gec olusturdugunda (Playables'ta
 * normal) onbellek "bellek yok" der ve panel bir daha kendine gelmez.
 */
async function selectFrame(frameId) {
  state.frameId = frameId;
  state.regionId = null;
  clearTimeout(state.regionPoll);

  const regionSel = $('regionSel');
  regionSel.textContent = '';
  regionSel.append(new Option('— sorgulaniyor… —', ''));
  setStatus('bellek araniyor…', 'busy');

  await pollRegions(0);
}

/** Bellek cikana kadar birkac saniye yeniden dener (oyun yukleniyor olabilir). */
async function pollRegions(attempt) {
  const askedFrame = state.frameId;
  const res = await rpc('regions');
  if (state.frameId !== askedFrame) return;   // kullanici arada frame degistirdi

  const regionSel = $('regionSel');
  const regions = (!res.error && res.result) || [];

  if (!regions.length) {
    regionSel.textContent = '';
    regionSel.append(new Option('— bellek bulunamadi —', ''));
    state.regionId = null;
    // 3 denemede cikmadiysa: diger frame'leri canli yokla, WASM'i olana atla.
    // Playables'ta oyun ic iframe'de calisiyor; kullaniciyi elle aratmayalim.
    if (attempt === 3) {
      const better = await findFrameWithMemory();
      if (better !== null && better !== state.frameId) {
        $('frameSel').value = String(better);
        toast('Oyun ' + (better === 0 ? 'ana sayfada' : 'iframe #' + better + '\'de') + ' bulundu, oraya gecildi.', 3500);
        selectFrame(better);
        return;
      }
    }

    if (attempt < 20) {
      setStatus(`bellek araniyor… (${attempt + 1})`, 'busy');
      state.regionPoll = setTimeout(() => pollRegions(attempt + 1), 1000);
    } else {
      setStatus('bellek yok', '');
      toast('Bu frame\'de WASM bellegi yok. Oyun saf JS olabilir ya da baska bir iframe\'de.', 5000);
    }
    return;
  }

  const keep = state.regionId;
  regionSel.textContent = '';
  for (const r of regions) {
    const tag = r.shared ? ' [paylasimli]' : '';
    regionSel.append(new Option(`${r.label} — ${fmtBytes(r.size)}${tag}`, r.id));
  }
  regionSel.value = regions.some((r) => r.id === keep) ? keep : regions[0].id;
  state.regionId = regionSel.value;
  setStatus(`bagli — ${regions.length} bellek`, 'on');

  if (regions.some((r) => r.shared)) {
    toast('Bellek paylasimli (pthread). Oyun dongusu bir Worker\'da calisiyor olabilir — ' +
          'tarama calisir ama zaman kontrolu etkisiz kalabilir.', 7000);
  }
}

/** Sekmenin tum frame'lerini canli yoklar, WASM bellegi olan ilkini doner. */
async function findFrameWithMemory() {
  const tab = state.targets.find((t) => t.tabId === state.tabId);
  if (!tab) return null;

  const probes = await Promise.all(tab.frames.map(async (f) => {
    const res = await rpcFrame(f.frameId, 'regions');
    const n = (!res.error && res.result) ? res.result.length : 0;
    return { frameId: f.frameId, n };
  }));

  const hit = probes.filter((p) => p.n > 0).sort((a, b) => b.n - a.n)[0];
  return hit ? hit.frameId : null;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

/* ------------------------------------------------------------------ *
 * Tarama
 * ------------------------------------------------------------------ */
function fillCmp(list) {
  const sel = $('cmpSel');
  const keep = sel.value;
  sel.textContent = '';
  for (const [v, label] of list) sel.append(new Option(label, v));
  if (list.some(([v]) => v === keep)) sel.value = keep;
  onCmpChange();
}

function onCmpChange() {
  const cmp = $('cmpSel').value;
  $('valInput').disabled = NO_VALUE.has(cmp);
  $('val2Wrap').classList.toggle('hidden', cmp !== 'between');
}

async function doScan(kind) {
  if (!state.regionId) { toast('Once taranacak bir bellek sec.'); return; }
  const cmp = $('cmpSel').value;
  const args = {
    region: state.regionId,
    type: $('typeSel').value,
    aligned: $('alignedChk').checked,
    cmp,
    value: $('valInput').value,
    value2: $('val2Input').value
  };

  if (!NO_VALUE.has(cmp) && args.value.trim() === '') { toast('Deger gir.'); return; }

  const res = await rpc(kind, args);
  if (res.error) { toast('Hata: ' + res.error); return; }

  state.scanning = true;
  setScanUI(true);
  pollProgress();
}

function setScanUI(busy) {
  $('firstBtn').disabled = busy;
  $('nextBtn').disabled = busy || !state.hasResults;
  $('newBtn').disabled = busy;
  $('cancelBtn').classList.toggle('hidden', !busy);
  setStatus(busy ? 'taraniyor...' : 'bagli', busy ? 'busy' : 'on');
}

async function pollProgress() {
  const res = await rpc('progress');
  if (res.error) { state.scanning = false; setScanUI(false); toast('Hata: ' + res.error); return; }
  const p = res.result;

  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  $('progBar').style.width = pct + '%';
  $('foundText').innerHTML = `Bulunan: <b>${p.found.toLocaleString('tr-TR')}</b>` +
    (p.running ? ` — %${pct.toFixed(0)}` : '');

  if (p.error) {
    state.scanning = false;
    setScanUI(false);
    toast('Tarama hatasi: ' + p.error);
    return;
  }

  if (p.running) { setTimeout(pollProgress, 150); return; }

  state.scanning = false;
  $('progBar').style.width = '100%';
  await loadResults();
  setScanUI(false);
}

async function loadResults() {
  const res = await rpc('results', { offset: 0, limit: 300 });
  if (res.error) { toast('Hata: ' + res.error); return; }
  const r = res.result;

  state.hasResults = r.total > 0 || r.mode === 'all';
  $('nextBtn').disabled = !state.hasResults;
  fillCmp(state.hasResults ? NEXT_CMPS : FIRST_CMPS);

  const body = $('resBody');
  body.textContent = '';

  if (r.mode === 'all') {
    $('resHint').classList.remove('hidden');
    $('resHint').innerHTML = '<b>Snapshot alindi.</b> Simdi oyunda degeri degistir, sonra ' +
      '<b>Sonraki Tarama</b>\'da <b>Artti / Azaldi / Degisti</b> sec. Klasik "degerini bilmiyorum" akisi.';
    $('foundText').innerHTML = `Snapshot: <b>${r.total.toLocaleString('tr-TR')}</b> aday adres`;
    return;
  }

  $('resHint').classList.toggle('hidden', r.rows.length > 0);
  if (r.truncated) toast(`Sonuc ${(4000000).toLocaleString('tr-TR')} adreste kesildi — daha dar bir deger ile tara.`, 5000);

  // "Hepsi" taramasinda hangi tipte kac eslesme var, ozet olarak goster
  if (r.multi && r.byType && Object.keys(r.byType).length) {
    const parts = Object.entries(r.byType).map(([t, n]) => `${t}:${n.toLocaleString('tr-TR')}`);
    $('foundText').innerHTML = `Bulunan: <b>${r.total.toLocaleString('tr-TR')}</b> — ${parts.join(' · ')}`;
  }

  for (const row of r.rows) {
    const tr = document.createElement('tr');
    tr.className = 'dbl';
    tr.title = 'Cift tikla → adres listesine ekle';
    tr.append(
      td('0x' + row.addr.toString(16).toUpperCase()),
      td(row.type || ''),
      td(String(row.value)),
      td(row.prev == null ? '' : String(row.prev))
    );
    tr.addEventListener('dblclick', () => addToList(row.addr, row.type, row.value));
    body.append(tr);
  }

  if (r.total > r.rows.length) {
    const tr = document.createElement('tr');
    const cell = td(`… ${(r.total - r.rows.length).toLocaleString('tr-TR')} sonuc daha (daralt)`);
    cell.colSpan = 4;
    cell.style.color = 'var(--muted)';
    tr.append(cell);
    body.append(tr);
  }
}

function td(text) {
  const c = document.createElement('td');
  c.textContent = text;
  return c;
}

/* ------------------------------------------------------------------ *
 * Adres listesi
 * ------------------------------------------------------------------ */
/** Adres listesi somut bir tip ister — "all" oraya gecemez. */
function concreteType(t) {
  return t && t !== 'all' ? t : (($('typeSel').value !== 'all' && $('typeSel').value) || 'i32');
}

function addToList(addr, type, value) {
  const entry = {
    key: 'k' + (state.keySeq++),
    desc: '',
    region: state.regionId,
    addr,
    type: concreteType(type),
    value: value == null ? '' : String(value),
    frozen: false,
    freezeId: null
  };
  state.list.push(entry);
  renderList();
}

function renderList() {
  const body = $('listBody');
  body.textContent = '';

  for (const e of state.list) {
    const tr = document.createElement('tr');

    // dondur
    const frz = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = e.frozen;
    chk.addEventListener('change', () => toggleFreeze(e, chk.checked));
    frz.append(chk);

    // aciklama
    const desc = document.createElement('td');
    const dIn = document.createElement('input');
    dIn.type = 'text';
    dIn.value = e.desc;
    dIn.placeholder = 'coin, can...';
    dIn.addEventListener('change', () => { e.desc = dIn.value; });
    desc.append(dIn);

    // adres + tip
    const addr = td('0x' + e.addr.toString(16).toUpperCase());

    const typ = document.createElement('td');
    const tSel = document.createElement('select');
    for (const opt of $('typeSel').options) {
      if (opt.value === 'all') continue;   // liste satiri somut tip ister
      tSel.append(new Option(opt.value, opt.value));
    }
    tSel.value = e.type;
    tSel.addEventListener('change', () => { e.type = tSel.value; if (e.frozen) toggleFreeze(e, true); });
    typ.append(tSel);

    // deger
    const val = document.createElement('td');
    const vIn = document.createElement('input');
    vIn.type = 'text';
    vIn.value = e.value;
    vIn.dataset.key = e.key;
    vIn.addEventListener('change', async () => {
      const res = await rpc('write', { region: e.region, addr: e.addr, type: e.type, value: vIn.value });
      if (res.error) { toast('Yazilamadi: ' + res.error); return; }
      e.value = vIn.value;
      if (e.frozen) toggleFreeze(e, true);   // dondurma degerini tazele
      toast('Yazildi: 0x' + e.addr.toString(16).toUpperCase() + ' = ' + vIn.value, 1400);
    });
    val.append(vIn);

    // sil
    const act = document.createElement('td');
    const x = document.createElement('button');
    x.className = 'cell-x';
    x.textContent = '×';
    x.title = 'Kaldir';
    x.addEventListener('click', async () => {
      if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
      state.list = state.list.filter((o) => o !== e);
      renderList();
    });
    act.append(x);

    tr.append(frz, desc, addr, typ, val, act);
    body.append(tr);
  }
}

async function toggleFreeze(e, on) {
  if (on) {
    const res = await rpc('freeze', { id: e.freezeId, region: e.region, addr: e.addr, type: e.type, value: e.value });
    if (res.error) { toast('Dondurulamadi: ' + res.error); return; }
    e.freezeId = res.result.id;
    e.frozen = true;
  } else {
    if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
    e.frozen = false;
    e.freezeId = null;
  }
}

/** Listedeki adreslerin canli degerlerini tazele (dondurulmayanlar). */
async function refreshListValues() {
  if (!state.list.length || state.tabId === null) return;
  const items = state.list
    .filter((e) => !e.frozen)
    .map((e) => ({ key: e.key, region: e.region, addr: e.addr, type: e.type }));
  if (!items.length) return;

  const res = await rpc('readMany', { items });
  if (res.error || !res.result) return;

  const focused = document.activeElement;
  for (const row of res.result) {
    if (row.value == null) continue;
    const e = state.list.find((o) => o.key === row.key);
    if (!e) continue;
    e.value = String(row.value);
    const input = document.querySelector(`#listBody input[data-key="${row.key}"]`);
    if (input && input !== focused) input.value = e.value;
  }
}

/* ------------------------------------------------------------------ *
 * Zaman kontrolu
 * ------------------------------------------------------------------ */
const PRESETS = [0.25, 0.5, 1, 2, 4, 8];

function buildPresets() {
  const box = $('presets');
  for (const s of PRESETS) {
    const b = document.createElement('button');
    b.textContent = s + 'x';
    b.dataset.speed = String(s);
    b.addEventListener('click', () => setSpeed(s));
    box.append(b);
  }
}

function applySpeedUI(s) {
  state.speed = s;
  $('speedRange').value = String(Math.round(s * 100));
  $('speedOut').textContent = s.toFixed(2) + 'x';
  for (const b of $('presets').children) {
    b.classList.toggle('on', Number(b.dataset.speed) === s);
  }
  $('pauseBtn').textContent = s === 0 ? 'Devam Et' : 'Duraklat';
  $('pauseBtn').classList.toggle('on', s === 0);
  $('stepBtn').disabled = s !== 0;
}

async function setSpeed(s) {
  const res = await rpc('setSpeed', { speed: s });
  if (res.error) { toast('Hiz ayarlanamadi: ' + res.error); return; }
  applySpeedUI(res.result.speed);
}

/**
 * Teshis satiri. "Hiz calismiyor" sikayetinin sebebini dogrudan gosterir:
 * oyun dongusu bu frame'de mi, saati okuyor mu, kac fps.
 */
async function refreshDiag() {
  const el = $('diag');
  if (state.tabId === null || state.frameId === null) { el.textContent = 'hedef secilmedi'; return; }

  const res = await rpc('diag');
  if (res.error || !res.result) { el.textContent = 'teshis alinamadi: ' + (res.error || '?'); return; }
  const d = res.result;

  const lines = [];
  const engines = d.engines.length ? d.engines.join(', ') : 'bilinmiyor';
  lines.push(`motor: <b>${engines}</b> · bellek: <b>${d.regions}</b>`);

  if (d.fps > 0) {
    lines.push(`render dongusu: <span class="good">${d.fps} fps</span> · saat okuma: <b>${d.nowReads.toLocaleString('tr-TR')}</b>`);
  } else if (d.timers > 0) {
    lines.push(`<span class="warn">rAF yok</span> · zamanlayici ile suruluyor (${d.timers}) · saat okuma: <b>${d.nowReads.toLocaleString('tr-TR')}</b>`);
  } else {
    lines.push('<span class="bad">bu frame\'de calisan bir oyun dongusu yok</span>');
  }

  if (d.nowReads === 0 && d.dateReads === 0 && d.fps > 0) {
    lines.push('<span class="bad">oyun saati hic okumuyor → hiz degisimi etki etmez</span>');
  }
  if (d.shared) {
    lines.push('<span class="bad">paylasimli bellek (pthread)</span> — dongu Worker\'da olabilir, zaman kontrolu ulasamaz');
  }
  if (!d.dirty) {
    lines.push('saat: <b>pass-through</b> (hiz henuz degistirilmedi)');
  } else {
    lines.push(`saat: <b>aktif ${d.speed}x</b>`);
  }

  el.innerHTML = lines.join('<br>');
}

/* ------------------------------------------------------------------ *
 * Baglama
 * ------------------------------------------------------------------ */
function wire() {
  $('refreshBtn').addEventListener('click', refreshTargets);
  $('reloadBtn').addEventListener('click', async () => {
    if (state.tabId === null) return;
    const keep = state.tabId;
    await bg({ op: 'reload', tabId: keep });
    setStatus('sekme yenileniyor…', 'busy');
    // Sayfa acilsin, agent enjekte olsun, sonra kendiliginden tazele
    setTimeout(async () => {
      state.tabId = keep;
      await refreshTargets();
    }, 1800);
  });

  $('tabSel').addEventListener('change', (e) => selectTab(Number(e.target.value)));
  $('frameSel').addEventListener('change', (e) => selectFrame(Number(e.target.value)));
  $('regionSel').addEventListener('change', (e) => { state.regionId = e.target.value || null; });
  $('cmpSel').addEventListener('change', onCmpChange);

  $('firstBtn').addEventListener('click', () => doScan('firstScan'));
  $('nextBtn').addEventListener('click', () => doScan('nextScan'));
  $('cancelBtn').addEventListener('click', () => rpc('cancelScan'));
  $('newBtn').addEventListener('click', async () => {
    await rpc('reset');
    state.hasResults = false;
    fillCmp(FIRST_CMPS);
    $('resBody').textContent = '';
    $('progBar').style.width = '0';
    $('foundText').textContent = 'Sonuc yok';
    $('resHint').classList.remove('hidden');
    $('resHint').innerHTML = 'Degeri oyunda gordugun gibi gir, <b>Ilk Tarama</b>\'ya bas. ' +
      'Sonra oyunda degeri degistir, <b>Sonraki Tarama</b> ile daralt. Satira cift tikla &rarr; listeye ekle.';
    setScanUI(false);
  });

  $('addManualBtn').addEventListener('click', () => {
    const raw = prompt('Adres (0x... veya ondalik):');
    if (!raw) return;
    const addr = raw.trim().toLowerCase().startsWith('0x') ? parseInt(raw.trim(), 16) : parseInt(raw.trim(), 10);
    if (!Number.isFinite(addr) || addr < 0) { toast('Gecersiz adres.'); return; }
    addToList(addr, concreteType(null), '');
  });

  $('clearListBtn').addEventListener('click', async () => {
    for (const e of state.list) if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
    state.list = [];
    renderList();
  });

  $('speedRange').addEventListener('input', (e) => {
    const s = Number(e.target.value) / 100;
    $('speedOut').textContent = s.toFixed(2) + 'x';
  });
  $('speedRange').addEventListener('change', (e) => setSpeed(Number(e.target.value) / 100));

  $('pauseBtn').addEventListener('click', () => {
    if (state.speed === 0) setSpeed(state.prevSpeed || 1);
    else { state.prevSpeed = state.speed || 1; setSpeed(0); }
  });
  $('stepBtn').addEventListener('click', () => rpc('step', { ms: 1000 / 60 }));
}

/* ------------------------------------------------------------------ *
 * Baslangic
 * ------------------------------------------------------------------ */
buildPresets();
fillCmp(FIRST_CMPS);
applySpeedUI(1);
wire();
refreshTargets();

setInterval(() => { if (!state.scanning) refreshListValues(); }, 400);
setInterval(() => { if (!state.scanning) refreshDiag(); }, 1000);
