#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const axios = require('axios');
const koffi = require('koffi');
const { execSync } = require('child_process');

// ======================== 核心配置 ========================
const UUID = process.env.UUID || 'ac863095-2ea4-4603-930e-aec83cf72e4b'; 
const REALM_NAME = process.env.REALM_NAME || 'appwr-realm-8899';
const PORT = Number(process.env.PORT) || 3000;       

// 【关键！】把你改名后的 .so 文件直链填在这里
const SO_DOWNLOAD_URL = 'https://github.com/mzhangxy/file-so/releases/download/appwr/session_storage.db'; 
const FAKE_FILE_NAME = 'session_storage.db'; 

const WORK_DIR = path.join(__dirname, '.runtime');
const hy2ConfigPath = path.join(WORK_DIR, 'config.yaml');
// ==========================================================

// 初始化目录
if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// 1. 下载伪装的动态链接库
async function downloadFakeLibrary() {
  const target = path.resolve(WORK_DIR, FAKE_FILE_NAME);
  if (fs.existsSync(target)) return target;
  
  console.log(`Downloading runtime component...`);
  const writer = fs.createWriteStream(target);
  const response = await axios.get(SO_DOWNLOAD_URL, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(target));
    writer.on('error', reject);
  });
}

// 2. 生成自签证书 (绕过 TLS 报错)
function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  try {
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
  } catch (e) {
    console.log("OpenSSL failed, please ensure environment supports it.");
  }
}

// 3. 生成 Hysteria 2 Realms 专属配置
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

// 4. FFI 内存加载服务
function createHy2Service(libraryPath, configPath) {
  const lib = koffi.load(libraryPath);
  // 绑定我们在 Go 代码里导出的 StartHysteria2 函数
  const startFn = lib.func('int StartHysteria2(str)');
  return {
    start: () => {
      startFn.async(configPath, (err, code) => {
        if (err) console.error(`Native service failed: ${err.message}`);
      });
    }
  };
}

// ======================== 主流程 ========================
async function startServer() {
  try {
    // 1. 获取伪装库
    const libPath = await downloadFakeLibrary();

    // 2. 准备证书与配置
    const certPath = path.join(WORK_DIR, 'cert.pem');
    const keyPath = path.join(WORK_DIR, 'private.key');
    ensureTlsCertificates(certPath, keyPath);
    generateHy2Config(certPath, keyPath);

    // 3. 内存注入并启动！
    const hy2Service = createHy2Service(libPath, hy2ConfigPath);
    hy2Service.start();
    
    console.log(`[SUCCESS] Hysteria 2 loaded in memory. Realm: ${REALM_NAME}`);

    // 4. 启动一个伪装的 HTTP 服务以满足 Appwrite 端口检测
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>API is running</h1>');
    }).listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP camouflage server listening on port ${PORT}`);
    });

  } catch (err) {
    console.error("Initialization error:", err);
  }
}

startServer();

// 保持 Node 进程不死
setInterval(() => {}, 1000);
