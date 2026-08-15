const fs = require('fs');
const https = require('https');
const path = require('path');

const dir = path.join(__dirname, 'assets', 'puzzles');
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
}

for (let i = 1; i <= 20; i++) {
    const dest = path.join(dir, `puzzle_${i}.jpg`);
    const file = fs.createWriteStream(dest);
    https.get(`https://picsum.photos/800/800?random=${i}`, function(response) {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            https.get(response.headers.location, function(res) {
                res.pipe(file);
            });
        } else {
            response.pipe(file);
        }
    });
}
console.log('Downloading 20 images to assets/puzzles...');
