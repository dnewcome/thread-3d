const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');

const MODEL_PATH = path.join(__dirname, 'model-cleaned.stl');

const ARTNET_PORT = 6454;
const ARTNET_HEADER = Buffer.from('Art-Net\0');
const OPCODE_DMX = 0x5000; // little-endian 0x0050

// Universe storage: universeData[universe] = Uint8Array(512)
const universeData = new Array(48).fill(null).map(() => new Uint8Array(512));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

// Art-Net DMX packet parser
// Returns { universe, data } or null if not a valid ArtDmx packet
function parseArtDmx(msg) {
  if (msg.length < 18) return null;
  if (!msg.slice(0, 8).equals(ARTNET_HEADER)) return null;

  const opcode = msg.readUInt16LE(8);
  if (opcode !== OPCODE_DMX) return null;

  // Universe is 15 bits: bits[3:0] = universe, bits[7:4] = subnet, bits[14:8] = net
  const univLow = msg[14];
  const univHigh = msg[15];
  const universe = (univHigh << 8) | univLow;

  const length = msg.readUInt16BE(16);
  const data = msg.slice(18, 18 + length);

  return { universe, data };
}

// Map Art-Net universe+channel data to LED indices
// Universe layout:
//   strand = floor(universe / 4)       (0-11)
//   univInStrand = universe % 4        (0-3)
//   reversed = strand is odd (1,3,5,7,9,11)
//
//   For a forward strand:
//     ledInStrand = univInStrand * 150 + channelIndex
//   For a reversed strand:
//     ledInStrand = 599 - (univInStrand * 150 + channelIndex)
//
//   globalLED = strand * 600 + ledInStrand
//
// Returns Float32Array of length 7200*3 (RGB floats 0-1)
function buildLEDColors() {
  const colors = new Float32Array(7200 * 3);

  for (let universe = 0; universe < 48; universe++) {
    const strand = Math.floor(universe / 4);
    const univInStrand = universe % 4;
    const reversed = (strand % 2) === 1;
    const dmx = universeData[universe];

    for (let led = 0; led < 150; led++) {
      const ch = led * 3;
      const r = dmx[ch] / 255;
      const g = dmx[ch + 1] / 255;
      const b = dmx[ch + 2] / 255;

      let ledInStrand;
      if (reversed) {
        ledInStrand = 599 - (univInStrand * 150 + led);
      } else {
        ledInStrand = univInStrand * 150 + led;
      }

      const globalLED = strand * 600 + ledInStrand;
      if (globalLED >= 0 && globalLED < 7200) {
        colors[globalLED * 3] = r;
        colors[globalLED * 3 + 1] = g;
        colors[globalLED * 3 + 2] = b;
      }
    }
  }

  return colors;
}

function startArtNet() {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg) => {
    const packet = parseArtDmx(msg);
    if (!packet) return;

    const { universe, data } = packet;
    if (universe < 0 || universe >= 48) return;

    universeData[universe].set(data.slice(0, Math.min(data.length, 512)));

    if (mainWindow) {
      const colors = buildLEDColors();
      mainWindow.webContents.send('led-update', colors.buffer);
    }
  });

  socket.on('error', (err) => {
    console.error('Art-Net UDP error:', err);
  });

  socket.bind(ARTNET_PORT, '0.0.0.0', () => {
    console.log(`Art-Net listening on UDP port ${ARTNET_PORT}`);
    socket.setBroadcast(true);
  });
}

// Serve model file to renderer via IPC to bypass file:// fetch restrictions
ipcMain.handle('read-model-file', async () => {
  const buf = fs.readFileSync(MODEL_PATH);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

app.whenReady().then(() => {
  createWindow();
  startArtNet();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
