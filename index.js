#!/usr/bin/env node

// Sử dụng readline để tạo prompt trên CLI
const readline = require('readline');
const {
    exec,
    execSync
} = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // NEW – tải file CDN
const cheerio = require('cheerio'); // NEW – phân tích HTML

// Tạo interface đọc/ghi
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// Hiển thị câu hỏi tới người dùng
rl.question('Website bạn muốn clone là: ', (url) => {
    console.log(`Bạn đã nhập: ${url}`);

    // Đảm bảo có thư mục dist để chứa kết quả
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, {
            recursive: true
        });
    }

    // Chuẩn bị và chạy lệnh wget
    const command = `wget --wait=2 --user-agent=Mozilla --no-parent --convert-links --adjust-extension ` +
        `--no-clobber -e robots=off --accept=html,htm --no-directories --level=1 ` +
        `-P "${distDir}" "${url}"`;

    console.log('Đang tiến hành tải website, vui lòng đợi...');

    exec(command, async (error, stdout, stderr) => {
        if (error) {
            console.error(`Đã xảy ra lỗi khi tải website: ${error.message}`);
        } else {
            if (stdout) console.log(stdout.trim());
            if (stderr) console.error(stderr.trim());
            console.log(`Hoàn tất! Các tệp đã được lưu trong thư mục: ${distDir}`);

            /* === BỔ SUNG: tách tài nguyên sau khi tải xong === */
            try {
                await processHTML(distDir, url);
                console.log('Đã tách/tải tài nguyên thành công!');
            } catch (e) {
                console.error('Lỗi khi xử lý tài nguyên:', e.message);
            }
        }
        // Đóng interface sau khi hoàn tất
        rl.close();
    });
});

/* ------------------------------------------------------------------ */
/* ------------------- HÀM HỖ TRỢ TÁCH TÀI NGUYÊN -------------------- */
/* ------------------------------------------------------------------ */
async function processHTML(distDir, baseUrl) {
    const htmlPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        console.warn('Không tìm thấy index.html – bỏ qua bước tách.');
        return;
    }

    // Tạo các thư mục đích
    const cssDir = path.join(distDir, 'css');
    const jsDir = path.join(distDir, 'js');
    const assetDir = path.join(distDir, 'asset');
    [cssDir, jsDir, assetDir].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
            recursive: true
        });
    });

    /* ---------- Đọc & phân tích HTML ---------- */
    const $ = cheerio.load(fs.readFileSync(htmlPath, 'utf-8'));

    /* ===== 1. INLINE <style> ===== */
    $('style').each((i, el) => {
        const cssContent = $(el).html();
        const fileName = `inline-${i + 1}.css`;
        fs.writeFileSync(path.join(cssDir, fileName), cssContent);
        $(el).replaceWith(`<link rel="stylesheet" href="./css/${fileName}">`);
    });

    /* ===== 2. INLINE <script> ===== */
    $('script:not([src])').each((i, el) => {
        const jsContent = $(el).html();
        const fileName = `inline-${i + 1}.js`;
        fs.writeFileSync(path.join(jsDir, fileName), jsContent);
        $(el).replaceWith(`<script src="./js/${fileName}"></script>`);
    });

    /* ===== 3. CDN CSS/JS ===== */
    const tasks = [];

    // a) <link rel="stylesheet" …>
    $('link[rel="stylesheet"]').each((i, el) => {
        const href = $(el).attr('href');
        if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
            tasks.push(downloadAndSwap($(el), 'href', href, cssDir));
        }
    });

    // b) <script src="…">
    $('script[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
            tasks.push(downloadAndSwap($(el), 'src', src, jsDir));
        }
    });

    /* ===== 4. CDN ảnh/gif/video ===== */
    const imgSelectors = ['img[src]', 'source[src]', 'video[src]'];
    $(imgSelectors.join(',')).each((i, el) => {
        const src = $(el).attr('src');
        if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
            tasks.push(downloadAndSwap($(el), 'src', src, assetDir));
        }
    });

    const taskResults = await Promise.all(tasks);

    /* -------- Lập map base URL cho từng file CSS từ CDN -------- */
    const cssRemoteBaseMap = {};
    taskResults.forEach(res => {
        if (res && res.type === 'css' && res.remoteUrl) {
            try {
                cssRemoteBaseMap[res.localFile] = new URL('./', res.remoteUrl).href;
            } catch {}
        }
    });

    /* ---------- Ghi lại HTML đã chỉnh ---------- */
    fs.writeFileSync(htmlPath, $.html(), 'utf-8');
    console.log('Đã cập nhật index.html');

    // === BỔ SUNG: Quét CSS và tải ảnh còn thiếu ===
    await processCSS(cssDir, assetDir, baseUrl, cssRemoteBaseMap);
    console.log('Đã quét CSS và tải tài nguyên còn thiếu!');
}

/* ----------------- HÀM TẢI FILE CDN ----------------- */
async function downloadAndSwap($node, attrName, remoteUrl, saveDir) {
    // Chuẩn hóa URL (xử lý dạng //cdn...)
    if (remoteUrl.startsWith('//')) remoteUrl = 'https:' + remoteUrl;
    const fileType = path.basename(saveDir); // css | js | asset

    try {
        const res = await axios.get(remoteUrl, {
            responseType: 'arraybuffer'
        });
        const ext = path.extname(new URL(remoteUrl).pathname) || '.bin';
        const base = path.basename(new URL(remoteUrl).pathname) || 'file';
        let file = base.includes('.') ? base : base + ext;

        // Tránh trùng tên
        let counter = 1;
        while (fs.existsSync(path.join(saveDir, file))) {
            file = `${path.parse(base).name}-${counter++}${ext}`;
        }

        fs.writeFileSync(path.join(saveDir, file), res.data);
        $node.attr(attrName, `./${path.basename(saveDir)}/${file}`);

        // Trả về thông tin để xử lý CSS về sau
        return {
            type: fileType,
            localFile: file,
            remoteUrl
        };
    } catch (e) {
        console.warn(`Không tải được ${remoteUrl}:`, e.message);
        return null;
    }
}

/* ----------------- HÀM QUÉT CSS VÀ TẢI ẢNH ----------------- */
async function processCSS(cssDir, assetDir, defaultBaseUrl, remoteBaseMap = {}) {
    const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'));

    // Regex mới: cho phép khoảng trắng + ngoặc kép
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

    for (const file of cssFiles) {
        const cssPath = path.join(cssDir, file);
        let content = fs.readFileSync(cssPath, 'utf-8');
        let modified = false;

        content = content.replace(urlRegex, (match, quote, raw) => {
            let resUrl = raw.trim();

            // Bỏ qua data URI hoặc fragment
            if (resUrl.startsWith('data:') || resUrl.startsWith('#')) return match;

            /* ------ Chuẩn hoá URL tuyệt đối ------ */
            if (resUrl.startsWith('//')) {
                resUrl = 'https:' + resUrl;
            } else if (!/^https?:\/\//i.test(resUrl)) {
                // Đường dẫn /a/b.png hoặc a/b.png → ghép với base URL tương ứng
                const baseRoot = remoteBaseMap[file] || defaultBaseUrl;
                try {
                    resUrl = new URL(resUrl, baseRoot).href;
                } catch {
                    return match;
                } // Không hợp lệ → giữ nguyên
            }

            /* ------ Sinh tên file cục bộ ------ */
            const {
                pathname
            } = new URL(resUrl);
            const ext = path.extname(pathname) || '.bin';
            const baseName = path.basename(pathname) || `file${ext}`;

            let localName = baseName;
            let count = 1;
            while (fs.existsSync(path.join(assetDir, localName))) {
                localName = `${path.parse(baseName).name}-${count++}${ext}`;
            }

            const localPath = path.join(assetDir, localName);

            /* ------ Tải về nếu chưa có ------ */
            if (!fs.existsSync(localPath)) {
                try {
                    execSync(`wget -q -O "${localPath}" "${resUrl}"`, {
                        stdio: 'ignore'
                    });
                } catch {
                    console.warn(`Không thể tải: ${resUrl}`);
                    return match; // Giữ nguyên nếu lỗi
                }
            }

            /* ------ Tính lại đường dẫn trong CSS ------ */
            // cssPath: dist/css/foo.css   ->   assetDir: dist/asset
            const rel = path.posix.relative(
                path.posix.dirname(`/css/${file}`), // "/css" để giữ nguyên separator posix
                `/asset/${localName}`
            ); // kết quả: "../asset/<file>"

            modified = true;
            return `url(${quote}${rel}${quote})`;
        });

        if (modified) {
            fs.writeFileSync(cssPath, content, 'utf-8');
            console.log(`✓ Đã cập nhật ${file}`);
        }
    }
}