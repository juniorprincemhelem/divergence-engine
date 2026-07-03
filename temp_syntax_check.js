const fs = require('fs');
const vm = require('vm');
const text = fs.readFileSync('server.js', 'utf8');
const script = text.split('<script>')[1].split('</script>')[0];
try {
  new vm.Script(script, { filename: 'inline.js' });
  console.log('OK');
} catch (e) {
  console.error('ERROR', e.message);
  console.error(e.stack);
  const lines = script.split('\n');
  const match = /inline\.js:(\d+):(\d+)/.exec(e.stack);
  if (match) {
    const line = Number(match[1]);
    const from = Math.max(0, line - 3);
    const to = Math.min(lines.length, line + 3);
    console.error('line', line);
    for (let i = from; i < to; i++) console.error((i + 1) + ': ' + lines[i]);
  }
}
