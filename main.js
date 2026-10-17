const { app, BrowserWindow, session, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path'), fs = require('fs');
let pending = null;
if (!app.requestSingleInstanceLock()) app.quit();

const SF = () => path.join(app.getPath('userData'), 'settings.json');
const UI = () => path.join(app.getPath('userData'), 'ui', 'index.html');
const { autoUpdater } = require('electron-updater');

// Auto-update: downloads new releases from GitHub in the background and installs them the next time the app closes.
const checkUpdates = () => { if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {}); };
const read = () => { try { return JSON.parse(fs.readFileSync(SF(), 'utf8')); } catch { return {}; } };
const decode = c => { try { const o = JSON.parse(Buffer.from(String(c).trim(), 'base64').toString()); return /^[\w.-]+\/[\w.-]+$/.test(o.r) ? o : null; } catch { return null; } };
// Reads a file from the host's GitHub repo; the unique query string defeats GitHub's cache.
const raw = async (repo, file) => {
  const r = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${file}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(r.status); return r.text();
};
async function resolveConfig() {
  const inv = decode(read().invite); if (!inv) return { hasInvite: false, server: '', password: '' };
  let server = ''; try { server = JSON.parse(await raw(inv.r, 'server.json')).url || ''; } catch {}
  return { hasInvite: true, server, password: inv.p || '' };
}
// Real-time updates: the interface is pulled from the repo on every launch (bundled copy is the fallback).
async function refreshUi() {
  const inv = decode(read().invite); if (!inv) return;
  try { const h = await raw(inv.r, 'ui/index.html'); if (h.includes('<html')) { fs.mkdirSync(path.dirname(UI()), { recursive: true }); fs.writeFileSync(UI(), h); } } catch {}
}

async function createWindow() {
  await refreshUi();
  const w = new BrowserWindow({
    width: 1200, height: 760, minWidth: 760, minHeight: 500, backgroundColor: '#12161c', autoHideMenuBar: true, title: 'Huddle',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  w.loadFile(decode(read().invite) && fs.existsSync(UI()) ? UI() : path.join(__dirname, 'renderer', 'index.html'));
  // Windows/Electron can leave the page without keyboard focus (inputs look dead); keep re-focusing it.
  w.webContents.on('did-finish-load', () => w.webContents.focus());
  w.on('focus', () => w.webContents.focus());
  w.webContents.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && (i.key === 'F12' || (i.control && i.shift && i.key.toLowerCase() === 'i'))) w.webContents.toggleDevTools(); });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'notifications', 'display-capture'].includes(perm)));
  ses.setDisplayMediaRequestHandler((req, cb) =>
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(s => cb({ video: s.find(x => x.id === pending) || s[0] })));
  ipcMain.handle('sources', async () =>
    (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
      .map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
  ipcMain.handle('get', () => read());
  ipcMain.handle('set', (e, patch) => {
    if (patch.invite !== undefined && !decode(patch.invite)) return false;
    fs.writeFileSync(SF(), JSON.stringify({ ...read(), ...patch })); return true;
  });
  ipcMain.handle('config', resolveConfig);
  ipcMain.on('pick', (e, id) => { pending = id; });
  createWindow();
  checkUpdates(); setInterval(checkUpdates, 30 * 60 * 1000); // on launch, then every 30 minutes
});
app.on('second-instance', () => { const [w] = BrowserWindow.getAllWindows(); if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on('window-all-closed', () => app.quit());
