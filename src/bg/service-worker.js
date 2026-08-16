/**
 * WebCheat service worker.
 *
 * Iki isi var:
 *   1. Uzanti ikonuna basilinca CE penceresini acmak
 *   2. Panel ile hedef frame'ler arasinda RPC trafigini yonlendirmek
 */

const PANEL_URL = 'src/ui/panel.html';
let panelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (e) {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL_URL),
    type: 'popup',
    width: 1180,
    height: 820
  });
  panelWindowId = win.id;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

/**
 * Tek bir frame'e RPC gonder.
 *
 * timeoutMs sart: askiya alinmis / donmus / servis worker'i olmeyen sekmelerde
 * sendMessage ne yanit doner ne de lastError set eder — sonsuza kadar asili
 * kalir. Tek bir bozuk sekme butun sekme listesini kilitliyordu.
 */
function rpc(tabId, frameId, payload, timeoutMs = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    if (timeoutMs > 0) setTimeout(() => done({ error: 'zaman asimi' }), timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, { __wce: 'rpc', payload }, { frameId }, (res) => {
        if (chrome.runtime.lastError) done({ error: chrome.runtime.lastError.message });
        else done(res || { error: 'bos yanit' });
      });
    } catch (e) {
      done({ error: String(e && e.message || e) });
    }
  });
}

const PROBE_TIMEOUT = 1500;

/**
 * Taranabilir hedefleri listele.
 *
 * Agent'i OLMAYAN sekmeleri de listeye koyuyoruz. Sebep: kullanicinin oyun
 * sekmesi cogu zaman uzanti kurulmadan/yenilenmeden once acilmis oluyor, o
 * sekmede content script yok. Onceden bu sekmeler listeden tamamen dusuyor ve
 * "sekmeyi bulamiyor" gibi gorunuyordu. Simdi gorunuyorlar, "agent yok"
 * isaretiyle — panel de yanina "Sekmeyi Yenile" diyor.
 */
async function listTargets() {
  const tabs = await chrome.tabs.query({});

  const results = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return null;

    const base = {
      tabId: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      discarded: !!tab.discarded,
      frames: [],
      hasAgent: false,
      hasMemory: false
    };

    // Uykuya alinmis sekmeyi uyandirmayalim — listede "askida" olarak gecsin
    if (tab.discarded) return base;

    let frames = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
    } catch (e) {
      frames = [{ frameId: 0, url: tab.url }];
    }

    const live = (await Promise.all(frames.map(async (fr) => {
      const res = await rpc(tab.id, fr.frameId, { cmd: 'hello' }, PROBE_TIMEOUT);
      if (!res || res.error || !res.result) return null;
      return {
        frameId: fr.frameId,
        url: res.result.url || fr.url,
        top: !!res.result.top,
        regions: res.result.regions || [],
        speed: res.result.speed
      };
    }))).filter(Boolean);

    live.sort((a, b) => (b.regions.length - a.regions.length) || (a.frameId - b.frameId));
    base.frames = live;
    base.hasAgent = live.length > 0;
    base.hasMemory = live.some((f) => f.regions.length > 0);
    return base;
  }));

  const out = results.filter(Boolean);
  // WASM'li sekmeler once, sonra agent'i olanlar, en sona olmayanlar
  out.sort((a, b) =>
    (b.hasMemory - a.hasMemory) ||
    (b.hasAgent - a.hasAgent) ||
    (a.tabId - b.tabId)
  );
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__wcePanel !== true) return;

  (async () => {
    try {
      switch (msg.op) {
        case 'listTargets':
          sendResponse({ result: await listTargets() });
          break;
        case 'rpc':
          // Panel hicbir zaman sonsuza kadar beklemesin
          sendResponse(await rpc(msg.tabId, msg.frameId, msg.payload, 20000));
          break;
        case 'reload':
          await chrome.tabs.reload(msg.tabId);
          sendResponse({ result: { ok: true } });
          break;
        default:
          sendResponse({ error: 'bilinmeyen op: ' + msg.op });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
  })();

  return true; // async
});
