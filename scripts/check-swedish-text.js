const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const suspicious = [];

html.split(/\n/).forEach((line, index) => {
  const damagedWord = /[A-Za-zÀ-ž]\?[A-Za-zÀ-ž]|\?[A-Za-zÀ-ž]/.test(line);
  const replacementChar = line.includes("\uFFFD");
  const expectedCode = line.includes("youtube.com/embed") || line.includes("target?.") || line.includes("slow ?");

  if ((damagedWord || replacementChar) && !expectedCode) {
    suspicious.push(`${index + 1}: ${line.trim()}`);
  }
});

if (suspicious.length) {
  console.error("Suspicious Swedish text encoding found:");
  console.error(suspicious.join("\n"));
  process.exit(1);
}

console.log("Swedish text encoding check passed.");
