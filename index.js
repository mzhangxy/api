#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ================= 配置区 =================
const WORK_DIR = process.env.FILE_PATH || '/tmp/hy2_env';
const HY2_PORT = process.env.HY2_PORT || 8443;
const HY2_PASSWORD = process.env.HY2_PASSWORD || 'your_secure_password';
// ==========================================

// 初始化工作目录
if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    console.log(`Created working directory: ${WORK_DIR}`);
}

const hy2Path = path.join(WORK_DIR, 'web'); // 将二进制文件命名为 web 以伪装
const configPath = path.join(WORK_DIR, 'config.yaml');
const logPath = path.join(WORK_DIR, 'hy2.log');

// 1. 获取系统架构并确定下载链接
function getHy2DownloadUrl() {
    const arch = os.arch();
    // 使用高速镜像源下载 Hysteria 2 (v2.4.0 为例)
    const baseUrl = 'https://ghproxy.net/https://github.com/apernet/hysteria/releases/download/app/v2.4.0';
    if (arch === 'arm64' || arch === 'aarch64') {
        return `${baseUrl}/hysteria-linux-arm64`;
    } else {
        return `${baseUrl}/hysteria-linux-amd64`;
    }
}

// 2. 下载 Hysteria 2
async function downloadHy2() {
    if (fs.existsSync(hy2Path)) {
        console.log('Hysteria 2 binary already exists. Skipping download.');
        return;
    }
    const url = getHy2DownloadUrl();
    console.log(`Downloading Hysteria 2 from ${url}...`);
    
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });
        const writer = fs.createWriteStream(hy2Path);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        fs.chmodSync(hy2Path, 0o755); // 赋予可执行权限
        console.log('Download and permission setup completed.');
    } catch (err) {
        console.error(`Download failed: ${err.message}`);
        throw err;
    }
}

// 3. 生成 Hysteria 2 Realms 配置文件
function generateConfig() {
    // 这里我们配置一个极简的 Realms 规则
    // 监听指定端口，使用自签证书，并设置一个密码
    const yamlConfig = `
listen: :${HY2_PORT}

tls:
  cert: "" # 留空以启用自签证书 (Hy2 会自动生成)

auth:
  type: password
  password: ${HY2_PASSWORD}

# Realms 流量分发配置测试
realms:
  - name: my-proxy
    domains:
      - proxy.example.com # 当客户端 SNI 为此域名时，作为代理流量
    handler: proxy
  - name: my-fake-web
    domains:
      - '*' # 其他所有域名，转发到本地伪装网页 (由于是 Serverless，我们转给 CF 测速点)
    handler: 
      type: forward
      forward:
        address: speed.cloudflare.com:443
`;
    fs.writeFileSync(configPath, yamlConfig);
    console.log('Hysteria 2 config.yaml generated.');
}

// 4. 启动 Hysteria 2 进程
async function startHy2() {
    try {
        // 检查是否已经在运行
        const status = execSync(`ps aux | grep -v "grep" | grep "${hy2Path}"`, { encoding: 'utf-8' });
        if (status.trim() !== '') {
            return 'Hysteria 2 is already running.';
        }
    } catch (e) {
        // 进程不存在，继续启动
    }

    console.log('Starting Hysteria 2...');
    // 使用 nohup 后台运行
    const command = `nohup ${hy2Path} server -c ${configPath} > ${logPath} 2>&1 &`;
    try {
        await execAsync(command);
        // 等待 2 秒让程序彻底启动
        await new Promise(resolve => setTimeout(resolve, 2000));
        return 'Hysteria 2 started successfully.';
    } catch (error) {
        return `Failed to start Hysteria 2: ${error.message}`;
    }
}

// ================= Appwrite 路由入口 =================
module.exports = async ({ req, res, log, error }) => {
    try {
        // 初始化运行环境
        await downloadHy2();
        generateConfig();
        const startResult = await startHy2();
        log(startResult);

        // 读取一下运行日志，看看有没有报错
        let hy2Logs = 'No logs available yet.';
        if (fs.existsSync(logPath)) {
            hy2Logs = fs.readFileSync(logPath, 'utf-8');
        }

        const report = {
            status: "Experimental Hysteria 2 Runner",
            action_result: startResult,
            hy2_port: HY2_PORT,
            hy2_password: HY2_PASSWORD,
            latest_logs: hy2Logs.split('\n').slice(-10) // 只看最后 10 行日志
        };

        return res.json(report, 200, {
            'Access-Control-Allow-Origin': '*'
        });

    } catch (err) {
        error(`Application Error: ${err.message}`);
        return res.json({ error: err.message }, 500);
    }
};
