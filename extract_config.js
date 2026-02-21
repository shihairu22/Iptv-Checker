const fs = require('fs');

const old = fs.readFileSync('old_index.js', { encoding: 'utf8' });

// The config routes start at app.get('/api/config/logo-templates'
const s1 = old.indexOf("app.get('/api/config/logo-templates',");
if (s1 === -1) { console.error("Could not find start of config routes"); process.exit(1); }

// They end before EPG cache but right after /config/epg-sources
const endToken1 = "const epgCache = new Map();";
const e1 = old.indexOf(endToken1);

// The EPG logic and routes start right after the cache definition
const s2 = old.indexOf("const epgCache = new Map();");
// They end before the app.get('/api/epg/category' (there might be export logic we want to avoid or just take the whole epg block)
const epgEndToken = old.indexOf("app.get('/api/export/m3u'");
const MathStrToken = "const MathStr";
const e2 = old.indexOf("// 数据导出接口") > -1 ? old.indexOf("// 数据导出接口") : epgEndToken;

let configBlock = old.slice(s1, e1);
let epgBlock = e2 > -1 ? old.slice(s2, e2) : old.slice(s2);

let code = `const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');
const streamService = require('../services/streamService');

const DATA_DIR = path.join(__dirname, '../../data');
const CFG_LOGO = path.join(DATA_DIR, 'logo_templates.json');
const CFG_FCC = path.join(DATA_DIR, 'fcc_servers.json');
const CFG_UDPXY = path.join(DATA_DIR, 'udpxy_servers.json');
const CFG_GROUPS = path.join(DATA_DIR, 'group_titles.json');
const CFG_GROUP_RULES = path.join(DATA_DIR, 'group_rules.json');
const CFG_EPG = path.join(DATA_DIR, 'epg_sources.json');
const CFG_PROXY = path.join(DATA_DIR, 'proxy_servers.json');
const CFG_APPSET = path.join(DATA_DIR, 'app_settings.json');
const EPG_DIR = path.join(DATA_DIR, 'epg');

function ensureDataDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}
function readJson(file, defObj) {
    ensureDataDir();
    try {
        if (fs.existsSync(file)) {
            const txt = fs.readFileSync(file, 'utf-8');
            return JSON.parse(txt);
        }
    } catch (e) { }
    return defObj;
}
function writeJson(file, obj) {
    ensureDataDir();
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8'); return true; } catch (e) { console.error('写入失败', file); return false; }
}

function normalizeProxyType(t) {
    const v = String(t || '').trim();
    if (v === '代理' || v === '单播代理') return '单播代理';
    if (v === '外网' || v === '组播代理') return '组播代理';
    const low = v.toLowerCase();
    if (low === 'proxy') return '单播代理';
    if (low === 'external' || low === 'internet') return '组播代理';
    return '组播代理';
}

function ensureEpgDir() {
    try {
        if (!fs.existsSync(EPG_DIR)) fs.mkdirSync(EPG_DIR, { recursive: true });
    } catch (e) { }
}

let settings = streamService.settings;
// Helper forwarder
Object.defineProperty(global, 'multicastList', { get: () => streamService.getStreams() });

${configBlock.replace(/app\./g, 'router.')}

${epgBlock.replace(/app\./g, 'router.')}

module.exports = router;
`;

fs.writeFileSync('src/routes/config.js', code);
console.log('Extraction complete. Wrote src/routes/config.js');
