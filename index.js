#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

// ================= 配置区 =================
// 选一个长且随机的 realm 名称，防止被扫到 (文档建议)
const REALM_NAME = process.env.REALM_NAME || 'my-api-test-realm-8899';
const HY2_PASSWORD = process.env.HY2_PASSWORD || 'K7m#9Qv2@L';
const WORK_DIR = path.join(__dirname, '.hy2_env');
// ==========================================

if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
}

const hy2Path = path.join(WORK_DIR, 'web'); 
const configPath = path.join(WORK_DIR, 'config.yaml');
const logPath = path.join(WORK_DIR, 'hy2.log');

// 1. 下载 Hysteria 2
async function downloadHy2() {
    if (fs.existsSync(hy2Path)) return;
    
    const arch = os.arch();
    const baseUrl = 'https://github.com/apernet/hysteria/releases/download/app/v2.4.0';
    const url = (arch === 'arm64' || arch === 'aarch64') ? `${baseUrl}/hysteria-linux-arm64` : `${baseUrl}/hysteria-linux-amd64`;
    
    console.log(`Downloading Hysteria 2...`);
    const response = await axios({ method: 'get', url: url, responseType: 'stream' });
    const writer = fs.createWriteStream(hy2Path);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    fs.chmodSync(hy2Path, 0o755);
}

// 2. 准备证书和配置文件
function prepareConfig() {
    // 生成自签证书以解决 TLS 问题
    if (!fs.existsSync(path.join(WORK_DIR, 'server.crt'))) {
        console.log('Generating self-signed certificate...');
        execSync(`cd ${WORK_DIR} && ./web cert`, { stdio: 'ignore' });
    }

    // listen 设为 realm URI，并禁用 sniGuard
    const yamlConfig = `
listen: realm://public@realm.hy2.io/${REALM_NAME}

auth:
  type: password
  password: ${HY2_PASSWORD}

tls:
  cert: ${path.join(WORK_DIR, 'server.crt')}
  key: ${path.join(WORK_DIR, 'server.key')}
  sniGuard: disable
`;
    fs.writeFileSync(configPath, yamlConfig);
}

// 3. 开启 Debug 模式启动
async function startHy2() {
    try {
        const status = execSync(`ps aux | grep -v "grep" | grep "${hy2Path}"`, { encoding: 'utf-8' });
        if (status.trim() !== '') return 'Hysteria 2 Realms is already running.';
    } catch (e) {}

    // 遇到连接问题使用 HYSTERIA_LOG_LEVEL=debug 运行
    const command = `cd ${WORK_DIR} && nohup env HYSTERIA_LOG_LEVEL=debug ./web server -c ${configPath} > ${logPath} 2>&1 &`;
    try {
        await execAsync(command);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return `Started successfully with Realm: ${REALM_NAME}`;
    } catch (error) {
        return `Failed to start: ${error.message}`;
    }
}

// ================= Appwrite 入口 =================
module.exports = async ({ req, res, log, error }) => {
    try {
        await downloadHy2();
        prepareConfig();
        const startResult = await startHy2();
        
        let hy2Logs = 'No logs';
        if (fs.existsSync(logPath)) {
            const allLogs = fs.readFileSync(logPath, 'utf-8').split('\n');
            hy2Logs = allLogs.slice(-15); // 获取最后15行Debug日志
        }

        return res.json({
            status: startResult,
            client_setup: {
                server: `realm://public@realm.hy2.io/${REALM_NAME}`,
                auth: HY2_PASSWORD,
                insecure: true
            },
            server_logs: hy2Logs
        }, 200, { 'Access-Control-Allow-Origin': '*' });

    } catch (err) {
        return res.json({ error: err.message }, 500);
    }
};
