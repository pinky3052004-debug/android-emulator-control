const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const multer = require('multer');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const execAsync = promisify(exec);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3001;
const ADB = process.env.ADB_PATH || 'adb';
const SESSION_DURATION = parseInt(process.env.SESSION_DURATION || '30') * 60 * 1000;
const SESSION_START = Date.now();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const storage = multer.diskStorage({
  destination: '/tmp/uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.apk')) cb(null, true);
    else cb(new Error('Only APK files allowed'));
  }
});

fs.mkdirSync('/tmp/uploads', { recursive: true });

async function adb(...args) {
  const { stdout, stderr } = await execAsync(`${ADB} ${args.join(' ')}`, { timeout: 30000 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function adbShell(command) {
  return adb('shell', `"${command.replace(/"/g, '\\"')}"`);
}

function getSessionInfo() {
  const elapsed = Date.now() - SESSION_START;
  const remaining = Math.max(0, SESSION_DURATION - elapsed);
  return {
    elapsed: Math.floor(elapsed / 1000),
    remaining: Math.floor(remaining / 1000),
    expiresAt: new Date(SESSION_START + SESSION_DURATION).toISOString(),
    percentage: Math.min(100, Math.floor((elapsed / SESSION_DURATION) * 100))
  };
}

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode}`);
  next();
});

app.get('/api/status', async (req, res) => {
  try {
    const { stdout: devices } = await adb('devices');
    const { stdout: bootCompleted } = await adbShell('getprop sys.boot_completed');
    const { stdout: androidVersion } = await adbShell('getprop ro.build.version.release');
    const { stdout: sdkVersion } = await adbShell('getprop ro.build.version.sdk');
    const { stdout: model } = await adbShell('getprop ro.product.model');
    const { stdout: batteryRaw } = await adbShell('dumpsys battery');
    const batteryLevel = batteryRaw.match(/level: (\d+)/)?.[1] || 'N/A';
    res.json({
      ok: true,
      session: getSessionInfo(),
      emulator: {
        connected: devices.includes('emulator'),
        booted: bootCompleted === '1',
        androidVersion, sdkVersion, model,
        batteryLevel: parseInt(batteryLevel)
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const tmpFile = `/tmp/screenshot-${Date.now()}.png`;
    await execAsync(`${ADB} exec-out screencap -p > ${tmpFile}`);
    if (!fs.existsSync(tmpFile)) throw new Error('Screenshot failed');
    const img = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(img);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/adb/shell', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });
  const blocked = ['rm -rf /', 'mkfs', 'dd if=', 'chmod 777 /'];
  if (blocked.some(b => command.includes(b)))
    return res.status(403).json({ ok: false, error: 'Command blocked' });
  try {
    const { stdout, stderr } = await adbShell(command);
    res.json({ ok: true, stdout, stderr });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/input/tap', async (req, res) => {
  const { x, y } = req.body;
  if (x === undefined || y === undefined)
    return res.status(400).json({ ok: false, error: 'x and y required' });
  try {
    await adbShell(`input tap ${Math.round(x)} ${Math.round(y)}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/input/swipe', async (req, res) => {
  const { x1, y1, x2, y2, duration = 300 } = req.body;
  try {
    await adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/input/text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const escaped = text.replace(/ /g, '%s').replace(/['"]/g, '\\$&');
    await adbShell(`input text "${escaped}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/input/keyevent', async (req, res) => {
  const { keycode } = req.body;
  const allowed = {
    HOME: 3, BACK: 4, MENU: 82, POWER: 26,
    VOLUME_UP: 24, VOLUME_DOWN: 25,
    DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
    ENTER: 66, DEL: 67, RECENT_APPS: 187
  };
  if (!allowed[keycode])
    return res.status(400).json({ ok: false, error: `Unknown keycode: ${keycode}` });
  try {
    await adbShell(`input keyevent ${allowed[keycode]}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/install-apk', upload.single('apk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'APK file required' });
  try {
    const { stdout } = await execAsync(`${ADB} install -r "${req.file.path}"`, { timeout: 120000 });
    fs.unlinkSync(req.file.path);
    if (stdout.includes('Success'))
      res.json({ ok: true, message: 'APK installed successfully' });
    else
      res.status(500).json({ ok: false, error: stdout });
  } catch (err) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/packages', async (req, res) => {
  try {
    const { stdout } = await adbShell('pm list packages -3');
    const packages = stdout.split('\n')
      .filter(l => l.startsWith('package:'))
      .map(l => l.replace('package:', '').trim());
    res.json({ ok: true, packages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/launch', async (req, res) => {
  const { packageName } = req.body;
  if (!packageName) return res.status(400).json({ ok: false, error: 'packageName required' });
  try {
    await adbShell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/logcat', async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines || '100'), 500);
  try {
    const { stdout } = await execAsync(`${ADB} logcat -d -t ${lines}`, { timeout: 10000 });
    res.json({ ok: true, logs: stdout });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

let recordingProcess = null;

app.post('/api/record/start', async (req, res) => {
  if (recordingProcess) return res.status(409).json({ ok: false, error: 'Already recording' });
  try {
    recordingProcess = spawn(ADB, ['shell', 'screenrecord', '/sdcard/recording.mp4'], { detached: true });
    res.json({ ok: true, message: 'Recording started' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/record/stop', async (req, res) => {
  if (!recordingProcess) return res.status(409).json({ ok: false, error: 'Not recording' });
  try {
    recordingProcess.kill('SIGINT');
    recordingProcess = null;
    await new Promise(r => setTimeout(r, 2000));
    const tmpFile = `/tmp/recording-${Date.now()}.mp4`;
    await execAsync(`${ADB} pull /sdcard/recording.mp4 ${tmpFile}`);
    await adbShell('rm /sdcard/recording.mp4');
    res.download(tmpFile, 'screen-recording.mp4', () => fs.unlinkSync(tmpFile));
  } catch (err) {
    recordingProcess = null;
    res.status(500).json({ ok: false, error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  const sessionTimer = setInterval(() => socket.emit('session', getSessionInfo()), 10000);

  let screenshotTimer = null;
  socket.on('start-stream', (fps = 2) => {
    const interval = Math.max(500, Math.floor(1000 / fps));
    screenshotTimer = setInterval(async () => {
      try {
        const tmpFile = `/tmp/ss-${socket.id}.png`;
        await execAsync(`${ADB} exec-out screencap -p > ${tmpFile}`);
        const img = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        socket.emit('frame', img.toString('base64'));
      } catch (e) {}
    }, interval);
  });

  socket.on('stop-stream', () => { if (screenshotTimer) clearInterval(screenshotTimer); });

  let logcatProcess = null;
  socket.on('start-logcat', () => {
    logcatProcess = spawn(ADB, ['logcat', '-v', 'time']);
    logcatProcess.stdout.on('data', (data) => socket.emit('logcat', data.toString()));
  });
  socket.on('stop-logcat', () => { if (logcatProcess) logcatProcess.kill(); });

  socket.on('disconnect', () => {
    clearInterval(sessionTimer);
    if (screenshotTimer) clearInterval(screenshotTimer);
    if (logcatProcess) logcatProcess.kill();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message });
});

server.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

setTimeout(() => {
  console.log('Session expired. Shutting down.');
  process.exit(0);
}, SESSION_DURATION);
