const fs = require("fs");

const FILE = "./database.json";

// dosya yoksa oluştur
if (!fs.existsSync(FILE)) {
  fs.writeFileSync(FILE, JSON.stringify({}));
}

// DB oku
function readDB() {
  try {
    const data = fs.readFileSync(FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

// DB yaz
function writeDB(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// güvenli kayıt (boşta tutuyorsun ama lazım olabilir)
function flushDatabase() {
  // şimdilik ekstra cache yok, ama hata önler
}

module.exports = {
  readDB,
  writeDB,
  flushDatabase
};
