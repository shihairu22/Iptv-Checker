const fs = require('fs');
let code = fs.readFileSync('src/routes/config.js', 'utf8');

// Replace corrupted "Unnammed" with correct single-quote ending
code = code.replace(/name: '鏈懡鍚嶆ā鏉\?,/g, "name: '未命名模板',");
code = code.replace(/name: '([^']*)\?,/g, "name: '未命名',");
code = code.replace(/name: t\.name \|\| '鏈懡鍚嶆ā鏉\?,/g, "name: t.name || '未命名模板',");

fs.writeFileSync('src/routes/config.js', code);
console.log('Fixed quotes.');
