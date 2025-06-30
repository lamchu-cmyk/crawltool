#!/usr/bin/env node

// Sử dụng readline để tạo prompt trên CLI
const readline = require('readline');
const {
    exec
} = require('child_process');
const fs = require('fs');
const path = require('path');

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

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Đã xảy ra lỗi khi tải website: ${error.message}`);
        } else {
            if (stdout) console.log(stdout.trim());
            if (stderr) console.error(stderr.trim());
            console.log(`Hoàn tất! Các tệp đã được lưu trong thư mục: ${distDir}`);
        }
        // Đóng interface sau khi hoàn tất
        rl.close();
    });
});