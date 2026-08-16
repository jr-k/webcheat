/**
 * WebCheat agent — MAIN world.
 *
 * Sayfanin kendi JS realm'inde calisir. Uc isi var:
 *   1. WebAssembly.Memory nesnelerini yakalamak (oyunun "RAM"i)
 *   2. O bellek uzerinde Cheat Engine tarzi tarama / yazma / dondurma
 *   3. Sanal saat ile oyunu hizlandirmak / yavaslatmak / duraklatmak
 *
 * document_start'ta yuklenmesi sart: WebAssembly hook'lari oyun instantiate
 * etmeden once takilmali. Sayfa zaten acikken uzanti kurulduysa bir kez
 * reload gerekir.
 */
(function () {
  'use strict';

  if (window.__WCE__) return;

  /* --------------------------------------------------------------------- *
   * Orijinal referanslar — kendi hook'larimizdan etkilenmemek icin
   * --------------------------------------------------------------------- */
  var O = {
    now: performance.now.bind(performance),
    dateNow: Date.now.bind(Date),
    raf: window.requestAnimationFrame && window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window)
  };

  /* --------------------------------------------------------------------- *
   * Deger tipleri
   * --------------------------------------------------------------------- */
  var TYPES = {
    i8:  { size: 1, arr: Int8Array,    big: false, get: function (d, o) { return d.getInt8(o); },        set: function (d, o, v) { d.setInt8(o, v); } },
    u8:  { size: 1, arr: Uint8Array,   big: false, get: function (d, o) { return d.getUint8(o); },       set: function (d, o, v) { d.setUint8(o, v); } },
    i16: { size: 2, arr: Int16Array,   big: false, get: function (d, o) { return d.getInt16(o, true); }, set: function (d, o, v) { d.setInt16(o, v, true); } },
    u16: { size: 2, arr: Uint16Array,  big: false, get: function (d, o) { return d.getUint16(o, true); },set: function (d, o, v) { d.setUint16(o, v, true); } },
    i32: { size: 4, arr: Int32Array,   big: false, get: function (d, o) { return d.getInt32(o, true); }, set: function (d, o, v) { d.setInt32(o, v, true); } },
    u32: { size: 4, arr: Uint32Array,  big: false, get: function (d, o) { return d.getUint32(o, true); },set: function (d, o, v) { d.setUint32(o, v, true); } },
    f32: { size: 4, arr: Float32Array, big: false, get: function (d, o) { return d.getFloat32(o, true); },set: function (d, o, v) { d.setFloat32(o, v, true); } },
    f64: { size: 8, arr: Float64Array, big: false, get: function (d, o) { return d.getFloat64(o, true); },set: function (d, o, v) { d.setFloat64(o, v, true); } },
    i64: { size: 8, arr: BigInt64Array,  big: true, get: function (d, o) { return d.getBigInt64(o, true); }, set: function (d, o, v) { d.setBigInt64(o, v, true); } },
    u64: { size: 8, arr: BigUint64Array, big: true, get: function (d, o) { return d.getBigUint64(o, true); },set: function (d, o, v) { d.setBigUint64(o, v, true); } }
  };

  function parseValue(type, raw) {
    var t = TYPES[type];
    if (!t) throw new Error('bilinmeyen tip: ' + type);
    if (t.big) return BigInt(String(raw).trim());
    var n = Number(raw);
    if (!isFinite(n)) throw new Error('gecersiz sayi: ' + raw);
    return n;
  }

  // JSON'a BigInt gonderemiyoruz — string'e ceviriyoruz.
  function outValue(v) { return typeof v === 'bigint' ? v.toString() : v; }

  /* --------------------------------------------------------------------- *
   * Bolgeler (regions) — taranabilir bellek alanlari
   * --------------------------------------------------------------------- */
  var regions = [];
  var regionSeq = 0;
  var OrigMemory = window.WebAssembly && window.WebAssembly.Memory;

  function addWasmMemory(mem, label) {
    if (!OrigMemory || !(mem instanceof OrigMemory)) return;
    for (var i = 0; i < regions.length; i++) if (regions[i].memory === mem) return;
    regions.push({
      id: 'wasm:' + (regionSeq++),
      kind: 'wasm',
      label: label || 'WebAssembly.Memory',
      memory: mem,
      buffer: function () { return mem.buffer; }
    });
  }

  function addBufferRegion(buf, label) {
    if (!(buf instanceof ArrayBuffer)) return;
    for (var i = 0; i < regions.length; i++) if (regions[i].kind === 'buffer' && regions[i].buffer() === buf) return;
    regions.push({
      id: 'buf:' + (regionSeq++),
      kind: 'buffer',
      label: label || 'ArrayBuffer',
      memory: null,
      buffer: function () { return buf; }
    });
  }

  function getRegion(id) {
    for (var i = 0; i < regions.length; i++) if (regions[i].id === id) return regions[i];
    throw new Error('bolge bulunamadi: ' + id);
  }

  /* --------------------------------------------------------------------- *
   * WebAssembly hook'lari
   * --------------------------------------------------------------------- */
  (function hookWasm() {
    var WA = window.WebAssembly;
    if (!WA) return;

    function harvest(result, importObject) {
      try {
        var im = importObject && importObject.env && importObject.env.memory;
        if (im) addWasmMemory(im, 'imports.env.memory');
      } catch (e) { /* import objesi exotic olabilir */ }
      try {
        var inst = result && result.instance ? result.instance : result;
        var ex = inst && inst.exports;
        if (ex) {
          for (var k in ex) {
            try { if (ex[k] instanceof OrigMemory) addWasmMemory(ex[k], 'exports.' + k); } catch (e2) {}
          }
        }
      } catch (e3) {}
    }

    try {
      WA.Memory = new Proxy(OrigMemory, {
        construct: function (target, args) {
          var m = Reflect.construct(target, args);
          addWasmMemory(m, 'new WebAssembly.Memory');
          return m;
        }
      });
    } catch (e) {}

    try {
      var OrigInstance = WA.Instance;
      WA.Instance = new Proxy(OrigInstance, {
        construct: function (target, args) {
          var i = Reflect.construct(target, args);
          harvest(i, args[1]);
          return i;
        }
      });
    } catch (e) {}

    ['instantiate', 'instantiateStreaming'].forEach(function (name) {
      var orig = WA[name];
      if (typeof orig !== 'function') return;
      WA[name] = function () {
        var args = arguments;
        var p = orig.apply(this, args);
        if (p && typeof p.then === 'function') {
          return p.then(function (r) { harvest(r, args[1]); return r; });
        }
        return p;
      };
    });
  })();

  /**
   * Gec kesif: hook'lardan kacan Emscripten/Unity modullerini yakala.
   * (uzanti sayfa yuklendikten sonra kurulduysa bu devreye girer)
   */
  var lastSweep = 0;
  function sweepGlobals() {
    // Her "hello"da global gezmek pahali: sekme listesi tum frame'leri
    // yokluyor ve YouTube gibi sayfalarda binlerce global var.
    var t0 = O.now();
    if (t0 - lastSweep < 1500) return;
    lastSweep = t0;

    var seen = 0;
    var names;
    try { names = Object.getOwnPropertyNames(window); } catch (e) { return; }
    for (var i = 0; i < names.length && seen < 4000; i++) {
      seen++;
      var v;
      try { v = window[names[i]]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      try {
        if (v.wasmMemory instanceof OrigMemory) addWasmMemory(v.wasmMemory, names[i] + '.wasmMemory');
        if (v.HEAPU8 && v.HEAPU8.buffer instanceof ArrayBuffer) addBufferRegion(v.HEAPU8.buffer, names[i] + '.HEAPU8');
        if (v.Module) {
          if (v.Module.wasmMemory instanceof OrigMemory) addWasmMemory(v.Module.wasmMemory, names[i] + '.Module.wasmMemory');
          if (v.Module.HEAPU8 && v.Module.HEAPU8.buffer instanceof ArrayBuffer) addBufferRegion(v.Module.HEAPU8.buffer, names[i] + '.Module.HEAPU8');
        }
      } catch (e) { /* getter patlayabilir */ }
    }
  }

  function listRegions() {
    sweepGlobals();
    return regions.map(function (r) {
      var size = 0, shared = false;
      try {
        var b = r.buffer();
        size = b.byteLength;
        shared = typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer;
      } catch (e) {}
      return { id: r.id, kind: r.kind, label: r.label, size: size, shared: shared };
    });
  }

  /** Sayfada hangi oyun motoru var — teshis icin. */
  function detectEngine() {
    var hits = [];
    var probes = [
      ['Unity', 'unityInstance'], ['Unity', 'UnityLoader'], ['Unity', 'createUnityInstance'],
      ['Emscripten', 'Module'], ['Godot', 'Godot'], ['Godot', 'Engine'],
      ['Cocos', 'cc'], ['Phaser', 'Phaser'], ['PixiJS', 'PIXI'],
      ['Construct', 'C3'], ['Three.js', 'THREE'], ['PlayCanvas', 'pc']
    ];
    for (var i = 0; i < probes.length; i++) {
      try { if (window[probes[i][1]] != null && hits.indexOf(probes[i][0]) < 0) hits.push(probes[i][0]); } catch (e) {}
    }
    return hits;
  }

  /* --------------------------------------------------------------------- *
   * Tarama motoru
   * --------------------------------------------------------------------- */
  var MAX_RESULTS = 4000000;   // ~16 MB offset tablosu
  var SLICE = 4000000;         // tik basina islenecek slot sayisi

  var scan = null;   // aktif tarama state'i
  var job = null;    // calisan tarama isi

  /**
   * "Hepsi" taramasinda denenen tipler — CE'nin "All" deger tipinin karsiligi.
   * u8/u16/u32 bilerek yok: ayni bit deseni zaten i8/i16/i32 ile yakalanir,
   * sadece isaret yorumu degisir. Lane sayisini iki katina cikarmaya degmez.
   */
  var MULTI_TYPES = ['i8', 'i16', 'i32', 'i64', 'f32', 'f64'];

  var INT_RANGE = {
    i8: [-128, 127], u8: [0, 255],
    i16: [-32768, 32767], u16: [0, 65535],
    i32: [-2147483648, 2147483647], u32: [0, 4294967295]
  };

  /** Deger bu tipte temsil edilebilir mi? "Hepsi" modunda bos lane elemek icin. */
  function fitsType(typeName, raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return false;
    if (typeName === 'f32' || typeName === 'f64') return isFinite(Number(s));
    if (!/^-?\d+$/.test(s)) return false;           // ondalik sayi tam sayi tipine girmez
    var t = TYPES[typeName];
    if (t.big) {
      try {
        var bv = BigInt(s);
        return typeName === 'u64'
          ? (bv >= BigInt(0) && bv < (BigInt(1) << BigInt(64)))
          : (bv >= -(BigInt(1) << BigInt(63)) && bv < (BigInt(1) << BigInt(63)));
      } catch (e) { return false; }
    }
    var r = INT_RANGE[typeName];
    var n = Number(s);
    return !r || (n >= r[0] && n <= r[1]);
  }

  /**
   * Tarama state'i. Sonuclar "lane"lere bolunur: lane i'nin sonuclari
   * offs[laneEnd[i-1] .. laneEnd[i]) araligindadir ve types[i] tipindedir.
   * Tek tipli taramada tek lane var; "Hepsi"nde tip basina bir lane.
   */
  function freshScan(regionId, types, aligned, multi) {
    return {
      region: regionId,
      types: types,        // lane tip adlari
      multi: !!multi,
      aligned: aligned !== false,
      mode: 'none',        // 'none' | 'all' | 'list'
      offs: null,          // Uint32Array — eslesen byte offsetleri
      laneEnd: [],         // her lane'in offs icindeki bitis indeksi
      count: 0,
      prevNum: null,       // Float64Array — onceki degerler
      prevBig: null,       // tek tipli 64-bit taramada tam hassasiyet
      snap: null,          // 'all' modunda tam bellek kopyasi
      truncated: false
    };
  }

  function typeAt(i) {
    for (var L = 0; L < scan.laneEnd.length; L++) if (i < scan.laneEnd[L]) return scan.types[L];
    return scan.types[scan.types.length - 1];
  }

  function prevAt(i) {
    if (scan.prevBig) return scan.prevBig[i];
    return scan.prevNum ? scan.prevNum[i] : undefined;
  }

  /** BigInt ile Number'i karsilastiramayiz; karisik lane'lerde sayiya indir. */
  function cmpVal(v) { return typeof v === 'bigint' ? Number(v) : v; }

  function storePrev(values, n) {
    var src = values.slice(0, n);
    var single = scan.types.length === 1 ? TYPES[scan.types[0]] : null;
    if (single && single.big) {
      scan.prevBig = scan.types[0] === 'u64' ? BigUint64Array.from(src) : BigInt64Array.from(src);
      scan.prevNum = null;
    } else {
      scan.prevBig = null;
      scan.prevNum = Float64Array.from(src.map(Number));
    }
  }

  // Buyuyebilen Uint32Array
  function Grow() {
    this.buf = new Uint32Array(1 << 16);
    this.n = 0;
  }
  Grow.prototype.push = function (v) {
    if (this.n === this.buf.length) {
      if (this.n >= MAX_RESULTS) return false;
      var next = new Uint32Array(Math.min(this.buf.length * 2, MAX_RESULTS));
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
    return true;
  };
  Grow.prototype.done = function () { return this.buf.subarray(0, this.n); };

  function yieldTick() {
    return new Promise(function (res) { O.setTimeout(res, 0); });
  }

  function makePredicate(op, a, b) {
    switch (op) {
      case 'eq':        return function (c) { return c === a; };
      case 'ne':        return function (c) { return c !== a; };
      case 'gt':        return function (c) { return c > a; };
      case 'lt':        return function (c) { return c < a; };
      case 'gte':       return function (c) { return c >= a; };
      case 'lte':       return function (c) { return c <= a; };
      case 'between':   return function (c) { return c >= a && c <= b; };
      case 'changed':   return function (c, p) { return c !== p; };
      case 'unchanged': return function (c, p) { return c === p; };
      case 'inc':       return function (c, p) { return c > p; };
      case 'dec':       return function (c, p) { return c < p; };
      case 'incBy':     return function (c, p) { return c - p === a; };
      case 'decBy':     return function (c, p) { return p - c === a; };
      default: throw new Error('bilinmeyen karsilastirma: ' + op);
    }
  }

  var NEEDS_PREV = { changed: 1, unchanged: 1, inc: 1, dec: 1, incBy: 1, decBy: 1 };

  function startJob(total) {
    job = { total: total, done: 0, found: 0, running: true, error: null, cancel: false };
    return job;
  }

  function slotCount(byteLen, typeName, aligned) {
    var t = TYPES[typeName];
    var step = aligned ? t.size : 1;
    return Math.max(0, Math.floor((byteLen - t.size) / step) + 1);
  }

  /** Ilk tarama. type='all' ise tum tipler ayri lane olarak taranir. */
  async function firstScan(opts) {
    var region = getRegion(opts.region);
    var aligned = opts.aligned !== false;
    var multi = opts.type === 'all';
    var types = multi ? MULTI_TYPES.slice() : [opts.type];
    for (var ti = 0; ti < types.length; ti++) {
      if (!TYPES[types[ti]]) throw new Error('bilinmeyen tip: ' + types[ti]);
    }

    scan = freshScan(opts.region, types, aligned, multi);
    var byteLen = region.buffer().byteLength;

    // --- Bilinmeyen deger: adres listesi tutmak yerine tam kopya al ---
    if (opts.cmp === 'unknown') {
      var j0 = startJob(byteLen);
      var snap = new Uint8Array(byteLen);
      var CH = 8 << 20;
      for (var off = 0; off < byteLen; off += CH) {
        if (j0.cancel) { j0.running = false; return; }
        // WASM bellegi tarama sirasinda buyurse eski ArrayBuffer detach olur.
        // Sessizce yarim snapshot almaktansa acikca patla.
        var live = region.buffer();
        if (live.byteLength < byteLen) throw new Error('bellek tarama sirasinda yeniden boyutlandi — tekrar tara');
        var end0 = Math.min(off + CH, byteLen);
        snap.set(new Uint8Array(live, off, end0 - off), off);
        j0.done = end0;
        await yieldTick();
      }
      scan.mode = 'all';
      scan.snap = snap;
      scan.count = types.reduce(function (s, tn) { return s + slotCount(byteLen, tn, aligned); }, 0);
      j0.found = scan.count;
      j0.running = false;
      return;
    }

    // --- Degerli ilk tarama ---
    var cmp = opts.cmp || 'eq';
    // Degeri temsil edemeyen tipleri lane listesinden dusur: 300 yazdiysan
    // i8'i taramanin anlami yok, 57.5 yazdiysan tam sayi tiplerinin.
    var lanes = types.filter(function (tn) {
      if (!fitsType(tn, opts.value)) return false;
      if (cmp === 'between' && !fitsType(tn, opts.value2)) return false;
      return true;
    });
    if (!lanes.length) throw new Error('"' + opts.value + '" secili tip(ler)de temsil edilemiyor');
    scan.types = lanes;

    var totalSlots = lanes.reduce(function (s, tn) { return s + slotCount(byteLen, tn, aligned); }, 0);
    var j = startJob(totalSlots);
    var out = new Grow();
    var prev = [];
    var base = 0;

    for (var li = 0; li < lanes.length; li++) {
      if (j.cancel || scan.truncated) { scan.laneEnd.push(out.n); continue; }

      var tn = lanes[li];
      var t = TYPES[tn];
      var a = parseValue(tn, opts.value);
      var b = cmp === 'between' ? parseValue(tn, opts.value2) : null;
      var pred = makePredicate(cmp, a, b);
      var slots = slotCount(byteLen, tn, aligned);

      if (aligned) {
        // Hizli yol: dogrudan typed array uzerinde gez
        var i = 0;
        while (i < slots) {
          if (j.cancel) break;
          var view = new t.arr(region.buffer());
          var end2 = Math.min(i + SLICE, Math.min(slots, view.length));
          for (; i < end2; i++) {
            if (pred(view[i])) {
              if (!out.push(i * t.size)) { scan.truncated = true; break; }
              prev.push(view[i]);
            }
          }
          j.done = base + i;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
      } else {
        // Hizalanmamis yol: DataView, byte byte
        var k = 0;
        while (k < slots) {
          if (j.cancel) break;
          var dv = new DataView(region.buffer());
          var end3 = Math.min(k + SLICE, slots);
          for (; k < end3; k++) {
            var v2 = t.get(dv, k);
            if (pred(v2)) {
              if (!out.push(k)) { scan.truncated = true; break; }
              prev.push(v2);
            }
          }
          j.done = base + k;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
      }

      scan.laneEnd.push(out.n);
      base += slots;
    }

    scan.mode = 'list';
    scan.offs = out.done();
    scan.count = out.n;
    storePrev(prev, out.n);
    j.done = j.total;
    j.found = scan.count;
    j.running = false;
  }

  /** Sonraki tarama — mevcut sonuc kumesini daraltir, lane yapisini korur. */
  async function nextScan(opts) {
    if (!scan || scan.mode === 'none') throw new Error('once ilk taramayi yap');
    var region = getRegion(scan.region);
    var cmp = opts.cmp || 'eq';
    var usesPrev = !!NEEDS_PREV[cmp];
    var wantsValue = !usesPrev || cmp === 'incBy' || cmp === 'decBy';
    var hasValue = opts.value != null && opts.value !== '';
    if (wantsValue && !hasValue) throw new Error('bu karsilastirma icin deger gerekli');

    var lanes = scan.types;
    var out = new Grow();
    var prev = [];
    var laneEnd = [];
    var exactPrev = !!scan.prevBig;   // tek tipli 64-bit: BigInt karsilastirmasi

    /** Lane bu degeri temsil edemiyorsa hic taramaya girme. */
    function laneUsable(tn) {
      if (!hasValue) return true;
      if (!wantsValue) return true;
      if (!fitsType(tn, opts.value)) return false;
      if (cmp === 'between' && !fitsType(tn, opts.value2)) return false;
      return true;
    }

    function laneCmp(tn) {
      var a = hasValue && wantsValue ? parseValue(tn, opts.value) : null;
      var b = cmp === 'between' && opts.value2 ? parseValue(tn, opts.value2) : null;
      return makePredicate(cmp, a, b);
    }

    if (scan.mode === 'all') {
      // Snapshot'a karsi tam tarama — sonuc artik seyrek bir liste olur
      var byteLen = region.buffer().byteLength;
      var snapView = new DataView(scan.snap.buffer);
      var totalSlots = lanes.reduce(function (s, tn) { return s + slotCount(byteLen, tn, scan.aligned); }, 0);
      var j = startJob(totalSlots);
      var base = 0;

      for (var li = 0; li < lanes.length; li++) {
        var tn = lanes[li];
        var t = TYPES[tn];
        var slots = slotCount(byteLen, tn, scan.aligned);

        if (j.cancel || scan.truncated || !laneUsable(tn)) {
          laneEnd.push(out.n);
          base += slots;
          continue;
        }

        var pred = laneCmp(tn);
        var step = scan.aligned ? t.size : 1;
        var i = 0;
        while (i < slots) {
          if (j.cancel) break;
          var dv = new DataView(region.buffer());
          var end = Math.min(i + SLICE, slots);
          for (; i < end; i++) {
            var off = i * step;
            if (off + t.size > scan.snap.length || off + t.size > dv.byteLength) continue;
            var cur = t.get(dv, off);
            var old = t.get(snapView, off);
            if (pred(cur, old)) {
              if (!out.push(off)) { scan.truncated = true; break; }
              prev.push(cur);
            }
          }
          j.done = base + i;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
        laneEnd.push(out.n);
        base += slots;
      }

      scan.snap = null; // artik gerek yok, RAM'i birak
      j.done = j.total;
      j.found = out.n;
      j.running = false;
    } else {
      // Liste modu — sadece mevcut adresleri, kendi lane tipiyle kontrol et
      var j2 = startJob(scan.count);
      var start = 0;

      for (var li2 = 0; li2 < lanes.length; li2++) {
        var tn2 = lanes[li2];
        var t2 = TYPES[tn2];
        var laneStop = scan.laneEnd[li2] != null ? scan.laneEnd[li2] : scan.count;

        if (j2.cancel || !laneUsable(tn2)) {
          j2.done = laneStop;
          laneEnd.push(out.n);
          start = laneStop;
          continue;
        }

        var pred2 = laneCmp(tn2);
        var n = start;
        while (n < laneStop) {
          if (j2.cancel) break;
          var dv2 = new DataView(region.buffer());
          var lim = dv2.byteLength;
          var end2 = Math.min(n + SLICE, laneStop);
          for (; n < end2; n++) {
            var off2 = scan.offs[n];
            if (off2 + t2.size > lim) continue;
            var cur2 = t2.get(dv2, off2);
            var p = usesPrev ? prevAt(n) : undefined;
            // prev sayisal tutuluyorsa BigInt tarafi da sayiya indirilmeli
            var c2 = exactPrev ? cur2 : cmpVal(cur2);
            if (pred2(c2, p)) {
              out.push(off2);
              prev.push(cur2);
            }
          }
          j2.done = n;
          j2.found = out.n;
          await yieldTick();
        }
        laneEnd.push(out.n);
        start = laneStop;
      }

      j2.done = j2.total;
      j2.found = out.n;
      j2.running = false;
    }

    scan.mode = 'list';
    scan.offs = out.done();
    scan.laneEnd = laneEnd;
    scan.count = out.n;
    storePrev(prev, out.n);
  }

  /** Lane basina sonuc sayisi — "hangi tipte kac tane" ozeti icin. */
  function laneCounts() {
    var out = {};
    var start = 0;
    for (var i = 0; i < scan.types.length; i++) {
      var stop = scan.laneEnd[i] != null ? scan.laneEnd[i] : start;
      if (stop > start) out[scan.types[i]] = stop - start;
      start = stop;
    }
    return out;
  }

  function scanResults(offset, limit) {
    if (!scan || scan.mode !== 'list') {
      return {
        total: scan ? scan.count : 0, rows: [], mode: scan ? scan.mode : 'none',
        multi: scan ? scan.multi : false, byType: {}
      };
    }
    var region = getRegion(scan.region);
    var dv = new DataView(region.buffer());
    var rows = [];
    var end = Math.min(offset + limit, scan.count);
    for (var i = offset; i < end; i++) {
      var tn = typeAt(i);
      var t = TYPES[tn];
      var off = scan.offs[i];
      var cur = null;
      try { if (off + t.size <= dv.byteLength) cur = t.get(dv, off); } catch (e) {}
      rows.push({
        addr: off,
        type: tn,
        value: outValue(cur),
        prev: outValue(prevAt(i))
      });
    }
    return {
      total: scan.count, rows: rows, mode: scan.mode, truncated: scan.truncated,
      multi: scan.multi, types: scan.types, byType: laneCounts(), region: scan.region
    };
  }

  /* --------------------------------------------------------------------- *
   * Okuma / yazma / dondurma
   * --------------------------------------------------------------------- */
  function readAddr(regionId, addr, type) {
    var region = getRegion(regionId);
    var t = TYPES[type];
    var dv = new DataView(region.buffer());
    if (addr < 0 || addr + t.size > dv.byteLength) return null;
    return t.get(dv, addr);
  }

  function writeAddr(regionId, addr, type, value) {
    var region = getRegion(regionId);
    var t = TYPES[type];
    var dv = new DataView(region.buffer());
    if (addr < 0 || addr + t.size > dv.byteLength) throw new Error('adres bellek disinda');
    t.set(dv, addr, parseValue(type, value));
    return true;
  }

  // Dondurulan adresler
  var frozen = Object.create(null);
  var freezeSeq = 0;
  var freezeTimer = null;

  function freezeTick() {
    for (var k in frozen) {
      var f = frozen[k];
      try { writeAddr(f.region, f.addr, f.type, f.value); } catch (e) { /* bellek buyumus/kucumus olabilir */ }
    }
  }

  function setFreeze(entry) {
    var id = entry.id || ('f' + (freezeSeq++));
    frozen[id] = { id: id, region: entry.region, addr: entry.addr, type: entry.type, value: entry.value };
    if (!freezeTimer) freezeTimer = O.setInterval(freezeTick, 16);
    return id;
  }

  function clearFreeze(id) {
    delete frozen[id];
    var any = false;
    for (var k in frozen) { any = true; break; }
    if (!any && freezeTimer) { O.clearInterval(freezeTimer); freezeTimer = null; }
    return true;
  }

  /* --------------------------------------------------------------------- *
   * Sanal saat — hizlandirma / yavaslatma / duraklatma
   * --------------------------------------------------------------------- *
   * Oyunlar delta time'i performance.now()/rAF timestamp'inden hesaplar.
   * Sanal saati hizli akitirsak simulasyon da hizlanir. Kod tarafinda
   * "1 kare = 1 kare" kaldigi icin fizik bozulmaz, sadece dt buyur.
   */
  var Clock = {
    speed: 1,
    // Uzanti <all_urls>'e enjekte oluyor. Hiz hic degistirilmediyse saat
    // TAMAMEN pass-through kalir — gezdigin hicbir sayfa etkilenmez.
    dirty: false,
    _rBase: O.now(),
    _vBase: O.now(),
    _dBase: O.dateNow(),
    _at: function (real) { return this._vBase + (real - this._rBase) * this.speed; },
    now: function () { return this.dirty ? this._at(O.now()) : O.now(); },
    dateNow: function () {
      return this.dirty ? this._dBase + (O.now() - this._rBase) * this.speed : O.dateNow();
    },
    setSpeed: function (s) {
      var real = O.now();
      // Ilk sapmada sanal saati o anki gercek zamandan baslat
      var v = this.dirty ? this._at(real) : real;
      var d = this.dirty ? this._dBase + (real - this._rBase) * this.speed : O.dateNow();
      this._vBase = v;
      this._dBase = d;
      this._rBase = real;
      this.speed = Math.max(0, Number(s) || 0);
      if (this.speed !== 1) this.dirty = true;
    },
    step: function (ms) {
      if (!this.dirty) return;
      this._vBase += ms;
      this._dBase += ms;
    }
  };

  /**
   * Teshis sayaclari. "Hiz calismiyor" dedigimizde sebebi bunlar soyler:
   * oyun dongusu bu frame'de mi, saati kimden okuyor, kac fps.
   */
  var stats = { now: 0, dateNow: 0, raf: 0, timeout: 0, interval: 0, rafWindow: [] };

  (function hookClock() {
    try {
      Object.defineProperty(performance, 'now', {
        configurable: true, writable: true,
        value: function now() { stats.now++; return Clock.now(); }
      });
    } catch (e) {}

    try {
      Date.now = function now() { stats.dateNow++; return Math.floor(Clock.dateNow()); };
    } catch (e) {}

    if (O.raf) {
      window.requestAnimationFrame = function (cb) {
        return O.raf(function (ts) {
          stats.raf++;
          var real = O.now();
          stats.rafWindow.push(real);
          while (stats.rafWindow.length && real - stats.rafWindow[0] > 1000) stats.rafWindow.shift();
          cb(Clock.dirty ? Clock.now() : ts);
        });
      };
    }

    // Zamanlayicilari hiza gore olcekle: 2x hizda 1000ms -> 500ms
    function scale(delay) {
      var d = Number(delay) || 0;
      if (!Clock.dirty || Clock.speed <= 0) return d;
      return d / Clock.speed;
    }
    window.setTimeout = function (fn, delay) {
      stats.timeout++;
      var rest = Array.prototype.slice.call(arguments, 2);
      return O.setTimeout.apply(window, [fn, scale(delay)].concat(rest));
    };
    window.setInterval = function (fn, delay) {
      stats.interval++;
      var rest = Array.prototype.slice.call(arguments, 2);
      return O.setInterval.apply(window, [fn, scale(delay)].concat(rest));
    };
  })();

  /* --------------------------------------------------------------------- *
   * RPC
   * --------------------------------------------------------------------- */
  /**
   * Taramayi arka planda baslatir; hata progress() uzerinden geri doner.
   *
   * Onceden .catch icinde "if (job)" vardi: ilk taramada henuz job olmadigi
   * icin (orn. "deger bu tipte temsil edilemiyor") hata hicbir yere yazilmadan
   * kayboluyor, panel sonsuza kadar bos sonuc gosteriyordu. Simdi cagriyla
   * birlikte bir job olusuyor, hata her durumda bir yere dusuyor.
   */
  function launch(fn, args) {
    if (job && job.running) throw new Error('tarama zaten calisiyor');
    job = { total: 0, done: 0, found: 0, running: true, error: null, cancel: false };
    Promise.resolve()
      .then(function () { return fn(args); })
      .catch(function (e) {
        if (!job) job = { total: 0, done: 0, found: 0, running: false, error: null, cancel: false };
        job.error = String(e && e.message || e);
        job.running = false;
      });
    return { started: true };
  }

  var HANDLERS = {
    hello: function () {
      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        top: window.top === window,
        regions: listRegions(),
        speed: Clock.speed
      };
    },
    regions: function () { return listRegions(); },

    firstScan: function (a) { return launch(firstScan, a); },
    nextScan: function (a) { return launch(nextScan, a); },
    cancelScan: function () { if (job) job.cancel = true; return { ok: true }; },
    progress: function () {
      return job
        ? { running: job.running, done: job.done, total: job.total, found: job.found, error: job.error }
        : { running: false, done: 0, total: 0, found: 0, error: null };
    },
    reset: function () { scan = null; job = null; return { ok: true }; },
    results: function (a) { return scanResults(a.offset || 0, Math.min(a.limit || 200, 1000)); },

    read: function (a) { return { value: outValue(readAddr(a.region, a.addr, a.type)) }; },
    readMany: function (a) {
      return (a.items || []).map(function (it) {
        var v = null;
        try { v = readAddr(it.region, it.addr, it.type); } catch (e) {}
        return { key: it.key, value: outValue(v) };
      });
    },
    write: function (a) { return { ok: writeAddr(a.region, a.addr, a.type, a.value) }; },

    freeze: function (a) { return { id: setFreeze(a) }; },
    unfreeze: function (a) { return { ok: clearFreeze(a.id) }; },

    setSpeed: function (a) { Clock.setSpeed(a.speed); return { speed: Clock.speed }; },
    step: function (a) { Clock.step(Number(a.ms) || 16.6667); return { ok: true }; },
    clock: function () { return { speed: Clock.speed, now: Clock.now() }; },

    diag: function () {
      var regs = listRegions();
      return {
        speed: Clock.speed,
        dirty: Clock.dirty,
        fps: stats.rafWindow.length,
        raf: stats.raf,
        nowReads: stats.now,
        dateReads: stats.dateNow,
        timers: stats.timeout + stats.interval,
        engines: detectEngine(),
        regions: regs.length,
        shared: regs.some(function (r) { return r.shared; }),
        crossOriginIsolated: !!window.crossOriginIsolated,
        workers: typeof Worker !== 'undefined'
      };
    }
  };

  function rpc(payloadJson) {
    var req;
    try { req = JSON.parse(payloadJson); } catch (e) { return { error: 'gecersiz istek' }; }
    var h = HANDLERS[req.cmd];
    if (!h) return { error: 'bilinmeyen komut: ' + req.cmd };
    try {
      return { result: h(req.args || {}) };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  }

  window.__WCE__ = { rpc: rpc, version: 1 };

  /* --------------------------------------------------------------------- *
   * Bridge (ISOLATED world) ile kopru
   * --------------------------------------------------------------------- */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__wce !== 'req') return;
    var res = rpc(d.payload);
    window.postMessage({ __wce: 'res', id: d.id, response: res }, '*');
  });
})();
