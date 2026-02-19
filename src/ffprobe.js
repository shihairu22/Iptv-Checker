const { exec } = require('child_process');

// 缓存检测结果
const streamCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

function ffprobeCheck(fullUrl, callback) {
    // 检查缓存
    const now = Date.now();
    const cached = streamCache.get(fullUrl);
    if (cached && (now - cached.timestamp) < CACHE_DURATION) {
        return callback(cached.data);
    }

    // 使用json格式输出，返回所有流（视频+音频）
    const cmd = `ffprobe -v quiet -print_format json -show_streams -show_programs -show_format "${fullUrl}"`;
    exec(cmd, { timeout: 8000 }, (error, stdout, stderr) => {
        let isAvailable = false;
        let frameRate = null;
        let bitRate = null;
        let resolution = null;
        let codec_name = null;
        let service_name = null;
        let hdr_type = null;
        let audio_codec = null;
        let audio_channels = null;
        let audio_sample_rate = null;
        let raw = null;
        try {
            if (!error && stdout) {
                const json = JSON.parse(stdout);
                raw = json;
                if (json.streams && json.streams.length > 0) {
                    // 查找第一个视频流
                    const vStream = json.streams.find(s => s.codec_type === 'video');
                    if (vStream) {
                        isAvailable = true;
                        codec_name = vStream.codec_name || null;
                        if (vStream.width && vStream.height) {
                            resolution = `${vStream.width}x${vStream.height}`;
                        }
                        bitRate = vStream.bit_rate ? parseInt(vStream.bit_rate) : null;
                        // 帧率
                        if (vStream.r_frame_rate && vStream.r_frame_rate.includes('/')) {
                            const [num, den] = vStream.r_frame_rate.split('/').map(Number);
                            if (!isNaN(num) && !isNaN(den) && den !== 0) {
                                frameRate = (num / den).toFixed(2);
                            }
                        }
                        // HDR/SDR 检测：通过 color_transfer 和 color_primaries 判断
                        const ct = vStream.color_transfer || '';
                        if (ct === 'smpte2084') {
                            hdr_type = 'HDR10';
                        } else if (ct === 'arib-std-b67') {
                            hdr_type = 'HLG';
                        } else if (vStream.color_primaries === 'bt2020') {
                            hdr_type = 'HDR';
                        } else {
                            hdr_type = 'SDR';
                        }
                    }
                    // 查找第一个音频流
                    const aStream = json.streams.find(s => s.codec_type === 'audio');
                    if (aStream) {
                        audio_codec = aStream.codec_name || null;
                        audio_channels = aStream.channels || null;
                        audio_sample_rate = aStream.sample_rate || null;
                    }
                }
                if (json.programs && Array.isArray(json.programs)) {
                    for (const p of json.programs) {
                        if (p.tags && (p.tags.service_name || p.tags.title)) {
                            service_name = p.tags.service_name || p.tags.title;
                            break;
                        }
                    }
                }
                if (!service_name && json.format && json.format.tags) {
                    service_name = json.format.tags.service_name || json.format.tags.title || null;
                }
            }
        } catch (e) {
            // 解析异常
        }
        // 计算网速
        let speed = null;
        if (bitRate) {
            speed = (bitRate / 8 / 1024).toFixed(2) + ' KB/s';
        }
        const result = {
            isAvailable,
            frameRate,
            bitRate,
            speed,
            resolution,
            codec: codec_name,
            serviceName: service_name,
            hdr: hdr_type,
            audio: audio_codec,
            audioChannels: audio_channels,
            audioSampleRate: audio_sample_rate,
            raw
        };
        // 缓存
        streamCache.set(fullUrl, { data: result, timestamp: Date.now() });
        callback(result);
    });
}

module.exports = { ffprobeCheck };
