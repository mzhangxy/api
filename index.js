const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { spawn, execSync } = require('child_process');

// ======================== 核心配置 ========================
const UUID = process.env.UUID || '5ca91fff-f64e-4896-acfa-d9e633b08e16'; 
const REALM_NAME = process.env.REALM_NAME || 'sapp-realm-8899';
// CF 平台会动态分配 PORT 环境变量，必须监听它
const PORT = process.env.PORT || 8080; 

// 替换为你的 .so 或二进制文件直链
const BINARY_DOWNLOAD_URL = 'https://github.com/mzhangxy/file-so/releases/download/appwr/session_storage.db'; 
const FAKE_FILE_NAME = 'session_storage.db';
// ==========================================================

const WORK_DIR = path.join(__dirname, '.runtime');
const hy2ConfigPath = path.join(WORK_DIR, 'config.yaml');

if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

async function downloadFakeBinary() {
  const target = path.resolve(WORK_DIR, FAKE_FILE_NAME);
  if (fs.existsSync(target)) return target;
  
  console.log(`Downloading runtime component...`);
  const writer = fs.createWriteStream(target);
  const response = await axios.get(BINARY_DOWNLOAD_URL, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      fs.chmodSync(target, 0o777); 
      resolve(target);
    });
    writer.on('error', reject);
  });
}

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  try {
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
  } catch (e) {
    console.log("OpenSSL failed, proceeding anyway.");
  }
}

function generateHy2Config(certPath, keyPath) {
  const yamlConfig = `
listen: realm://public@realm.hy2.io/${REALM_NAME}

auth:
  type: password
  password: ${UUID}

tls:
  cert: ${certPath}
  key: ${keyPath}
  sniGuard: disable
`;
  fs.writeFileSync(hy2ConfigPath, yamlConfig);
}

// ======================== 主流程 ========================
async function startServer() {
  try {
    const binaryPath = await downloadFakeBinary();
    const certPath = path.join(WORK_DIR, 'cert.pem');
    const keyPath = path.join(WORK_DIR, 'private.key');
    
    ensureTlsCertificates(certPath, keyPath);
    generateHy2Config(certPath, keyPath);

    // 静默启动后台进程
    try {
      const status = execSync(`ps aux | grep -v "grep" | grep "${FAKE_FILE_NAME}"`, { encoding: 'utf-8' });
      if (status.trim() === '') throw new Error("Not running");
    } catch (e) {
      console.log(`Starting ${FAKE_FILE_NAME} in background...`);
      const hy2Process = spawn(binaryPath, ['server', '-c', hy2ConfigPath], {
        detached: true,
        stdio: 'ignore',
        cwd: WORK_DIR
      });
      hy2Process.unref();
    }
    
    console.log(`[SUCCESS] Runtime process launched.`);

    // 【关键】启动真实的 HTTP 服务器，占住 CF 分配的端口，保持容器存活
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>System Core is Online (SAP BTP CF)</h1>');
    }).listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP server listening on port ${PORT}`);
    });

  } catch (err) {
    console.error("Initialization error:", err);
  }
}

startServer();
