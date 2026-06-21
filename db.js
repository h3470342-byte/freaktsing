const fs = require("fs");

const dbFile = "./db.json";

// DB yoksa oluştur
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(dbFile, JSON.stringify({}));
}

// Veriyi oku
function readDB() {
  return JSON.parse(fs.readFileSync(dbFile, "utf-8"));
}

// Veriyi kaydet
function writeDB(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

module.exports = {
  readDB,
  writeDB
};
