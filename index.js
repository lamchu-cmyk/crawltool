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

    /* ==== 1. LOẠI BỎ COMMENT HTML THỪA ==== */
    $('*') // duyệt mọi phần tử
        .contents() // lấy tất cả node con
        .filter((_, el) => el.type === 'comment') // lọc node comment
        .remove(); // xoá hẳn khỏi DOM

    /* ===== 1. INLINE <style> ===== */
    $('style').each((i, el) => {
        const cssContent = $(el).html();
        const fileName = `inline-${i + 1}.css`;
        fs.writeFileSync(path.join(cssDir, fileName), cssContent);
        $(el).replaceWith(`<link rel="stylesheet" href="./css/${fileName}">`);
    });

    /* ===== 2. INLINE <script> ===== */
    $('script:not([src])').each((i, el) => {
        const type = ($(el).attr('type') || '').trim().toLowerCase();

        // Nếu là JSON-LD, template, ld+json … thì giữ nguyên
        if (type && type !== 'text/javascript' && type !== 'application/javascript') return;

        // Phần còn lại mới tách ra file
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

    // Chờ tất cả hoàn thành, kể cả lỗi
    const settled = await Promise.allSettled(tasks);
    const taskResults = settled
        .filter(r => r.status === 'fulfilled' && r.value) // bỏ reject & null
        .map(r => r.value);

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
    if (remoteUrl.startsWith('//')) remoteUrl = 'https:' + remoteUrl;

    /* ---- 1. Decide the final folder that the asset should live in ---- */
    let targetDir = saveDir; // default for css / js
    const ext = path.extname(new URL(remoteUrl).pathname) || '.bin';
    if (path.basename(saveDir) === 'asset') { // only categorise real assets
        const subDir = getAssetSubDir(ext);
        targetDir = path.join(saveDir, subDir);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, {
            recursive: true
        });
    }

    /* ---- 2. Resolve a unique local filename ---- */
    const base = path.basename(new URL(remoteUrl).pathname) || 'file';
    const file = base.includes('.') ? base : base + ext;
    let finalName = file,
        n = 1;
    while (fs.existsSync(path.join(targetDir, finalName))) {
        finalName = `${path.parse(file).name}-${n++}${ext}`;
    }

    /* ---- 3. Download & write ------------------------------------------------ */
    try {
        const { data } = await axios.get(remoteUrl, {
            responseType: 'arraybuffer',
            // Một số CDN yêu cầu UA; thêm nhẹ cho chắc
            headers: { 'User-Agent': 'Mozilla/5.0 (crawltool)' }
        });
        fs.writeFileSync(path.join(targetDir, finalName), data);
    } catch (err) {
        console.warn(`Không thể tải ${remoteUrl}: ${err.response?.status || err.message}`);
        return null;          // báo về "không thành công" nhưng KHÔNG quăng lỗi
    }

    /* ---- 4.  Update the DOM attribute so it points to the new file ---------- */
    const relPath = path.posix.relative(
        path.posix.dirname('/'), // root → easiest
        path.posix.join('/', path.basename(saveDir), // '/asset'
            path.relative(saveDir, targetDir), // 'img' | 'font'…
            finalName) // the file
    );
    $node.attr(attrName, `./${relPath}`);

    return {
        type: path.basename(saveDir), // 'css', 'js', or 'asset'
        localFile: path.join(path.relative(saveDir, targetDir), finalName),
        remoteUrl
    };
}

/* ----------------- HÀM QUÉT CSS VÀ TẢI ẢNH ----------------- */
async function processCSS(cssDir, assetDir, defaultBaseUrl, remoteBaseMap = {}) {
    const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'));
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

    for (const file of cssFiles) {
        const cssPath = path.join(cssDir, file);
        let content = fs.readFileSync(cssPath, 'utf-8');
        let modified = false;

        content = content.replace(urlRegex, (match, quote, raw) => {
            let resUrl = raw.trim();
            if (resUrl.startsWith('data:') || resUrl.startsWith('#')) return match;

            /* ---- Build an absolute URL like before --------------------------- */
            if (resUrl.startsWith('//')) resUrl = 'https:' + resUrl;
            else if (!/^https?:\/\//i.test(resUrl)) {
                const base = remoteBaseMap[file] || defaultBaseUrl;
                try {
                    resUrl = new URL(resUrl, base).href;
                } catch {
                    return match;
                }
            }

            /* ---- Decide sub-folder, file name & final path ------------------- */
            const {
                pathname
            } = new URL(resUrl);
            const ext = path.extname(pathname) || '.bin';
            const subDir = getAssetSubDir(ext);
            const baseName = path.basename(pathname) || `file${ext}`;

            let localName = baseName,
                c = 1;
            const targetDir = path.join(assetDir, subDir);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, {
                recursive: true
            });

            while (fs.existsSync(path.join(targetDir, localName))) {
                localName = `${path.parse(baseName).name}-${c++}${ext}`;
            }

            const localPath = path.join(targetDir, localName);

            /* ---- Download if we have not done so already ---------------------- */
            if (!fs.existsSync(localPath)) {
                try {
                    execSync(`wget -q -O "${localPath}" "${resUrl}"`, {
                        stdio: 'ignore'
                    });
                } catch {
                    console.warn(`Không thể tải: ${resUrl}`);
                    return match;
                }
            }

            /* ---- Rewrite URL relative to the current css/xx.css -------------- */
            const rel = path.posix.relative(
                path.posix.dirname(`/css/${file}`),
                `/asset/${subDir}/${localName}`
            );

            modified = true;
            return `url(${quote}${rel}${quote})`;
        });

        if (modified) {
            fs.writeFileSync(cssPath, content, 'utf-8');
            console.log(`✓ Đã cập nhật ${file}`);
        }
    }
}

/* ===================================================================== */
/* 1)  Helper: decide sub-folder name from file extension                 */
/* ===================================================================== */
function getAssetSubDir(ext) {
    ext = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(ext)) return 'img';
    if (['.ttf', '.otf', '.woff', '.woff2', '.eot'].includes(ext)) return 'font';
    if (['.mp4', '.webm', '.m4v', '.avi', '.mov'].includes(ext)) return 'video';
    if (['.mp3', '.ogg', '.wav'].includes(ext)) return 'audio';
    return 'misc'; // everything else – keep it but isolate it
}