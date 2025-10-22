const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Point to your local backend server (Express serving the HTML)
  win.loadURL('http://localhost:3000');

  win.webContents.on('did-fail-load', () => {
    win.loadFile(path.join(__dirname, '/static/offline.html'));
  });

  win.setTitle('Hyperion POC');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
