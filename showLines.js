const fs = require("fs");
const text = fs.readFileSync("server.js","utf8");
const script = text.split("<script>")[1].split("</script>")[0];
const lines = script.split("\n");
const ln = 431;
const from = Math.max(0, ln - 3);
const to = Math.min(lines.length, ln + 3);
console.log('line', ln);
for (let i = from; i < to; i++) console.log((i+1) + ': ' + lines[i]);
